import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Offline verdict test for docktarget-native.mjs: the driver's page
// expressions evaluated against a stubbed inspector, at a passing state, at
// states where the handover failed, and against a dead inspector. No
// browser, no chan, no guest, no network beyond loopback. Disk reads hit a
// real temp workspace seeded like the shell seeds the guest's.
const driverUrl = new URL("./docktarget-native.mjs", import.meta.url);
const driverSource = readFileSync(driverUrl, "utf8");

test("the driver sends no awaitPromise and waits nowhere in the page", () => {
  assert.doesNotMatch(driverSource, /awaitPromise:\s*true/, "no awaitPromise in Runtime.evaluate");
  assert.doesNotMatch(driverSource, /setTimeout\s*\(\s*tick/, "no in-page poll loops");
});

const STUB = `
function inspectorEval(endpoint, titleSub, expression, timeoutMs) {
  return (async () => {
    const e = expression;
    const has = (s) => e.includes(s);
    const scenario = process.env.P6PROOF_SCENARIO;
    if (scenario === "dead") throw new Error("inspector socket failed");
    // The WebKitGTK inspector has no awaitPromise: an async page expression
    // answers at once instead of its value. Read every async source the
    // way the guest does; a driver that evaluates one can never go green.
    if (/\\basync\\b/.test(e)) return {};
    if (has("dblclick")) return "entered";
    if (has('"tab"')) return scenario === "deck-dropped" ? "elsewhere: BODY." : "tab";
    if (has("chan:command")) return "toggled";
    if (has("browser-toolbar")) return "opened";
    if (has(".twirl")) return "opening";
    if (has(".click()")) return "clicked";
    if (has("hamburger-menu")) return "toggle";
    if (has("combobox")) return "open";
    if (has("deck-result-title")) return scenario === "no-handover" && has("Copy path") ? null : "picked";
    if (has("Command launcher") && has('"open" : "closed"')) return scenario === "deck-closed-on-row" ? "closed" : "open";
    if (has("Command launcher") && has('"closed"')) return "closed";
    if (has("browser-side-pane.left")) return e.includes('"closed"') ? "closed" : true;
    if (has("aria-expanded")) return "open";
    if (has("/notes/b.md")) return "/TESTWS/notes/b.md";
    if (has("/notes")) return "/TESTWS/notes";
    if (has("/docs/a.md")) return "/TESTWS/docs/a.md";
    if (has('endsWith("/docs")')) return "/TESTWS/docs";
    if (has(".browser:not(.dock)")) return true;
    if (has(".browser.dock")) return true;
    if (has("listbox")) return true;
    throw new Error("unstubbed expression: " + e.slice(0, 80));
  })();
}
`;

function stagedDriver() {
  const start = driverSource.indexOf("function inspectorEval(");
  const end = driverSource.indexOf("}\n\nconst run =");
  assert.ok(start >= 0 && end > start, "inspectorEval bounds found; test tracks the driver shape");
  const withStub = `${driverSource.slice(0, start)}${STUB}\n${driverSource.slice(end + 2)}`
    .replace(/const xdo = \(args[^;]*;/, "const xdo = (args) => ({ status: 0 });")
    .replace(/const clip = \(\)[^;]*;/, 'const clip = () => ({ status: 0, stdout: process.env.P6PROOF_CLIP ?? "" });');
  assert.ok(!withStub.includes("awaitPromise: true"), "staged driver sends no awaitPromise");
  const dir = join(tmpdir(), `p6proof-docktarget-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "driver-under-test.mjs");
  writeFileSync(file, withStub);
  return { dir, file };
}

function runDriver(scenario, clipboard, extra = []) {
  const { dir, file } = stagedDriver();
  const ws = join(dir, "ws");
  mkdirSync(join(ws, "docs"), { recursive: true });
  mkdirSync(join(ws, "notes"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "dock file\n");
  writeFileSync(join(ws, "notes", "b.md"), "tab file\n");
  const out = join(dir, "out");
  let stdout = "";
  let code = -1;
  try {
    stdout = execFileSync(process.execPath, [file, "--inspector", "127.0.0.1:1", "--out", out,
      "--xid", "0x1", "--workspace", ws, "--sha", "b".repeat(40), "--engine-version", "proof", ...extra],
      { encoding: "utf8", timeout: 300_000, env: { ...process.env, P6PROOF_SCENARIO: scenario, P6PROOF_CLIP: clipboard } });
    code = 0;
  } catch (err) {
    code = err.status ?? -1;
    stdout = String((err.stdout ?? "") + (err.stderr ?? ""));
  }
  const lines = stdout.split("\n").filter((l) => l.includes("docktarget-native:"));
  let json = null;
  try { json = JSON.parse(readFileSync(join(out, "docktarget-native.json"), "utf8")); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return { code, lines, json };
}

const TAB_PATH = "notes/b.md";

test("correct behaviour exits 0 with twenty-two ok lines and PASS", () => {
  const { code, lines, json } = runDriver("correct", TAB_PATH);
  assert.equal(code, 0);
  assert.equal(lines.filter((l) => l.includes(" ok ")).length, 22);
  assert.ok(lines.some((l) => l.includes(" ok Copy path copied the tab's file")), "missing the clipboard read");
  assert.ok(lines.some((l) => l.endsWith("PASS")));
  assert.equal(json?.ok, true);
  assert.equal(json?.exitCode, 0);
  assert.equal(json?.clipboard, TAB_PATH);
});

test("a clipboard holding the dock's file exits 10 on the property", () => {
  const { code, lines, json } = runDriver("correct", "docs/a.md");
  assert.equal(code, 10);
  assert.ok(lines.some((l) => l.includes("FAIL Copy path copied the tab's file")), "missing clipboard FAIL");
  assert.equal(json?.exitCode, 10);
  assert.equal(json?.ok, false);
});

test("an empty clipboard exits 3", () => {
  const { code, lines } = runDriver("correct", "");
  assert.equal(code, 3);
  assert.ok(lines.some((l) => l.includes("FAIL clipboard readable within the hang guard")), "missing clipboard precondition");
});

test("a missing handover target exits 3 before the drive", () => {
  const { code, lines } = runDriver("no-handover", "");
  assert.equal(code, 3);
  assert.ok(lines.some((l) => l.includes("FAIL launcher picked Copy path")), "missing launcher FAIL");
});

test("a dead inspector exits 3", () => {
  const { code } = runDriver("dead", "");
  assert.equal(code, 3);
});

test("closing the dock by the deck's row, then Escape, exits 0 and PASS", () => {
  const { code, lines, json } = runDriver("correct", TAB_PATH, ["--close-by", "deck"]);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes(" ok deck picked the dock row")), "missing the deck's dock row");
  assert.ok(lines.some((l) => l.includes(" ok deck dismissed by Escape")), "missing the Escape");
  assert.ok(lines.some((l) => l.includes(" ok keyboard is inside the tab's tree after Escape")), "missing the hand-back read");
  assert.ok(lines.some((l) => l.endsWith("PASS")));
  assert.equal(json?.closeBy, "deck");
  assert.equal(json?.exitCode, 0);
});

test("a deck close that leaves the tab without the keyboard exits 10 there", () => {
  const { code, lines, json } = runDriver("deck-dropped", TAB_PATH, ["--close-by", "deck"]);
  assert.equal(code, 10);
  assert.ok(lines.some((l) => l.includes("FAIL keyboard is inside the tab's tree after Escape elsewhere: BODY.")), "missing the hand-back FAIL");
  assert.ok(!lines.some((l) => l.includes("Copy path")), "the run stops before the copy");
  assert.equal(json?.exitCode, 10);
});

test("an unknown close mode refuses before the drive", () => {
  const { code, lines } = runDriver("correct", "", ["--close-by", "chord"]);
  assert.notEqual(code, 0);
  assert.equal(lines.filter((l) => l.includes(" ok ")).length, 0);
});

test("an absolute path to the tab's file counts as the tab's file", () => {
  const { code, json } = runDriver("correct", "/TESTWS/notes/b.md");
  assert.equal(code, 0);
  assert.equal(json?.clipboard, "/TESTWS/notes/b.md");
});

test("a deck that closes on the dock row exits 3 before the Escape", () => {
  const { code, lines } = runDriver("deck-closed-on-row", TAB_PATH, ["--close-by", "deck"]);
  assert.equal(code, 3);
  assert.ok(lines.some((l) => l.includes("FAIL deck stays open on the dock row")), "missing the deck-open precondition");
  assert.ok(!lines.some((l) => l.includes("deck dismissed by Escape")), "the run stops before the Escape");
});
