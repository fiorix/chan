#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

const xdo = (args, opts = {}) => exec("xdotool", args.map(String), { encoding: "utf8", timeout: 15_000, ...opts });

async function inspectorTargets(endpoint) {
  const html = await (await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) })).text();
  const found = [];
  for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (!path) continue;
    found.push({ socket: `${endpoint}${path}`, text: cells.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return found;
}

function inspectorEval(endpoint, titleSub, expression) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (...a) => { if (!settled) { settled = true; try { ws.close(); } catch {} fn(...a); } };
    const ok = done(resolve), fail = done(reject);
    const timer = setTimeout(() => fail(new Error("inspector did not answer in 8s")), 8000);
    let ws;
    let page = null;
    inspectorTargets(endpoint).then((found) => {
      const target = found.find((e) => e.text.includes(titleSub));
      if (!target) { clearTimeout(timer); fail(new Error(`no inspectable page matches ${JSON.stringify(titleSub)}`)); return; }
      ws = new WebSocket(`ws://${target.socket}`);
      const send = (targetId) => {
        const inner = JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } });
        ws.send(JSON.stringify({ id: 1, method: "Target.sendMessageToTarget", params: { targetId, message: inner } }));
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !page) {
          page = message.params.targetInfo.targetId;
          send(page);
        } else if (message.method === "Target.dispatchMessageFromTarget" && page) {
          const inner = JSON.parse(message.params.message);
          if (inner.id !== 1) return;
          clearTimeout(timer);
          if (inner.error || inner.result?.wasThrown) fail(new Error(`page threw: ${JSON.stringify(inner).slice(0, 400)}`));
          else ok(inner.result.result.value);
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail(new Error("inspector socket failed")); };
    }).catch((err) => { clearTimeout(timer); fail(err); });
  });
}

import { CASES } from "../browser-smoke/lib/native-input/cases.mjs";
import { FIND_TERM_SRC, INSTALL_SRC, READ_SRC, RESET_SRC, WRAP_OPEN_SRC } from "../browser-smoke/lib/native-input/page.mjs";
import { validateCaseFile, validateRunSummary } from "../browser-smoke/lib/native-input/schema.mjs";
import { NAV_COUNTER_SRC, pollWrapBox, waitBooted, windowLive } from "../browser-smoke/lib/native-input/boot-wait.mjs";
import { recorderIdentity, readWorktreeSha } from "../browser-smoke/lib/native-input/identity.mjs";
import { startTerminalFixture } from "../browser-smoke/lib/terminal-fixture.mjs";
import { drainPointerInput } from "../browser-smoke/lib/terminal-pointer.mjs";
import { join } from "node:path";

const TERM_KEY = "__nativeInputTermsWk";
const TAB = "SmokeNativeInputWk";

const a = argsOf(process.argv.slice(2));
for (const k of ["inspector", "out", "xid", "sha", "engine-version"]) {
  if (!a[k]) throw new Error(`usage: native-input-record.mjs --inspector H:P --out DIR --xid XID --sha SHA --engine-version V (missing --${k})`);
}
const { CHAN_BIN, CHAN_CONTROL_SOCKET, CHAN_WINDOW_ID } = process.env;
if (!CHAN_BIN || !CHAN_CONTROL_SOCKET || !CHAN_WINDOW_ID) throw new Error("need CHAN_BIN, CHAN_CONTROL_SOCKET, CHAN_WINDOW_ID in the environment");
mkdirSync(a.out, { recursive: true });

const transport = await startTerminalFixture({ logPath: join(a.out, "program-output.bin"), deadlineMs: 20_000 });
try {
  const csNew = () => exec(CHAN_BIN, ["shell", "terminal", "new", "--tab-name", TAB,
    "--command", "stty -opost -echo && " + transport.command,
    ...Object.entries(transport.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])],
    { env: { ...process.env, CHAN_CONTROL_SOCKET, CHAN_WINDOW_ID }, encoding: "utf8", timeout: 90_000 });
  const recorderId = recorderIdentity("webkit");
  const guestLayout = async () => {
    try {
      const out = await exec("setxkbmap", ["-query"], { encoding: "utf8", timeout: 15_000 });
      return (/^layout:\s*(.+)$/m.exec(out.stdout || "")?.[1] ?? "unknown").trim() || "unknown";
    } catch {
      return "unknown";
    }
  };
  const evaluate = (expr) => inspectorEval(a.inspector, "/workspace-", expr);
  const summary = {
    engine: "webkitgtk",
    engineVersion: a["engine-version"],
    worktreeSha: readWorktreeSha(a.sha),
    started: new Date().toISOString(),
    finished: "",
    cases: {},
    notDriven: {},
    boot: { retried: false, attempts: [], prefs: { wrote: false } },
  };

  const boxOf = async () => evaluate(`(() => { const el = document.querySelector(".terminal-tab.active .terminal-host"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const until = async (read, pred, label, bound = 60_000) => {
    const deadline = Date.now() + bound;
    for (;;) {
      const v = await read();
      if (pred(v)) return v;
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await sleep(500);
    }
  };

  const mask = (s) => String(s ?? "").replaceAll(transport.env.TERMINAL_FIXTURE_TOKEN, "[redacted]").replace(/([?&]t=)[^&\s"']*/g, "$1<token>");
  const failures = [];
  const failKind = (kind) => failures.filter((f) => f.kind === kind).length;
  await windowLive(async () => {
    try {
      await exec(CHAN_BIN, ["shell", "pane", "list", "--window", CHAN_WINDOW_ID, "--json"],
        { env: { ...process.env, CHAN_CONTROL_SOCKET, CHAN_WINDOW_ID }, encoding: "utf8", timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }, { label: `window ${CHAN_WINDOW_ID}` });
  await evaluate(NAV_COUNTER_SRC);
  await waitBooted(evaluate, { label: "workspace page" });
  await evaluate(INSTALL_SRC);
  const wrap = await pollWrapBox(evaluate, WRAP_OPEN_SRC, TERM_KEY);
  summary.boot = { retried: wrap.retried, attempts: wrap.attempts, prefs: { wrote: false } };
  await evaluate(INSTALL_SRC);
  await csNew();
  const ready = await transport.ready();
  if (!ready.tty || !ready.raw) throw new Error("input fixture requires a raw PTY");
  const hostQuery = await until(async () => {
    const box = await boxOf();
    return box ? ".terminal-tab.active .terminal-host" : null;
  }, Boolean, "the new terminal tab to attach");
  await until(async () => evaluate(`(() => !!document.querySelector(".terminal-tab.active .terminal-host canvas"))()`),
    Boolean, "terminal canvas", 30_000);
  const hooked = await evaluate(`(${FIND_TERM_SRC})(${JSON.stringify(TERM_KEY)}, ${JSON.stringify(hostQuery)})`);
  if (hooked !== "hooked") throw new Error("no ghostty-web Terminal holds this tab's terminal host");
  const hookedOnce = await evaluate(READ_SRC);
  if (hookedOnce.terms !== 1) throw new Error(`expected one hooked terminal, found ${hookedOnce.terms}`);

  const focus = async () => {
    const box = await boxOf();
    if (!box) throw new Error("terminal host has no box");
    await xdo(["windowactivate", "--sync", a.xid]);
    await xdo(["mousemove", "--window", a.xid, String(Math.round(box.x)), String(Math.round(box.y)), "click", "1"]);
    await sleep(200);
    const focused = await evaluate(`(() => { const ae = document.activeElement; return ae ? !!ae.closest(".terminal-host") : false; })()`);
    if (!focused) throw new Error("the terminal host is not focused after the click");
  };

  const mouse = async (buttons) => {
    const box = await boxOf();
    if (!box) throw new Error("terminal host has no box");
    const x = String(Math.round(box.x));
    const y = String(Math.round(box.y));
    for (const b of buttons) {
      if (b === "down:1") await xdo(["mousemove", "--window", a.xid, x, y, "mousedown", "1"]);
      else if (b === "up:1") await xdo(["mousemove", "--window", a.xid, x, y, "mouseup", "1"]);
      else if (b === "wheelUp") await xdo(["mousemove", "--window", a.xid, x, y, "click", "4"]);
      else if (b === "wheelDown") await xdo(["mousemove", "--window", a.xid, x, y, "click", "5"]);
      else throw new Error(`unknown mouse button ${b}`);
      await sleep(200);
    }
  };

  for (const c of CASES) {
    if (!c.webkit) {
      summary.cases[c.id] = "not-driven";
      summary.notDriven[c.id] = c.webkitReason ?? c.pendingReason ?? "no webkit steps";
      continue;
    }
    const fail = (reason, kind = "property") => {
      failures.push({ name: c.id, kind, detail: reason });
      summary.cases[c.id] = "failed";
      writeFileSync(`${a.out}/${c.id}.error.txt`, `${mask(reason)}\n`);
    };
    let programSetup;
    try {
      await focus();
      const setup = programSetup = await drainPointerInput(transport, c.program ?? "");
      if (setup.input !== (c.programReply ?? "")) throw new Error(`unexpected input before case: ${JSON.stringify(setup.input)}`);
    } catch (error) { fail(`program setup: ${error.message}`, "instrument"); continue; }
    try {
      await evaluate(RESET_SRC);
      const composing = await evaluate("window.__nativeInput.composing").catch(() => null);
      if (composing !== false) {
        fail("composition state is active or unreadable at case start", "instrument");
        continue;
      }
      const offset = transport.records.length;
      let done = false;
      try {
        for (const step of c.webkit.steps) {
          switch (step.op) {
            case "focus": break; // Focus precedes the recorder reset.
            case "xdo": await xdo(step.args); break;
            case "mouse": await mouse(step.buttons); break;
            case "sleep": await sleep(step.ms); break;
            case "reset": await evaluate(RESET_SRC); break;
            case "clipboard": {
              const clip = spawnSync("xclip", ["-selection", "clipboard", "-i"], { input: step.text, encoding: "utf8", timeout: 15_000 });
              if (clip.status !== 0) throw new Error(`xclip exited ${clip.status}: ${(clip.stderr || "").slice(0, 200)}`);
              break;
            }
            default: throw new Error(`unknown step op ${step.op}`);
          }
        }
      } catch (err) {
        fail(`drive failed: ${String(err).slice(0, 300)}`, "instrument");
        done = true;
      }
      if (done) continue;
      let drained;
      try { drained = await drainPointerInput(transport, "", offset); }
      catch (error) { fail(`PTY barrier: ${error.message}`, "instrument"); continue; }
      let snap;
      try {
        snap = await evaluate(READ_SRC);
      } catch (err) {
        fail(`read failed: ${String(err).slice(0, 300)}`, "instrument");
        continue;
      }
      if (snap.hookError) {
        fail(`hook failed: ${snap.hookError}`, "instrument");
        continue;
      }
      const ptyBytes = drained.input;
      const untrusted = snap.events.filter((e) => e.isTrusted !== true);
      if (untrusted.length > 0) {
        fail(`${untrusted.length} untrusted events (first: ${JSON.stringify(untrusted[0]).slice(0, 200)})`, "instrument");
        continue;
      }
      const types = new Set(snap.events.map((e) => e.type));
      const missing = (c.expect.dom ?? []).filter((t) => !types.has(t));
      const emitted = snap.bytes.map((b) => b.data).join("");
      // Exclude the separately recorded program reply from input bytes.
      const widgetBytes = emitted.endsWith(drained.reply) ? emitted.slice(0, -drained.reply.length) : emitted;
      const verdict = { status: "ok", reason: "" };
      if (missing.length > 0) {
        verdict.status = "failed";
        verdict.reason = `missing DOM event types: ${missing.join(",")}`;
        fail(verdict.reason, "property");
      } else if (c.expect.paneTreeFocused && !snap.paneTreeFocused) {
        verdict.status = "failed";
        verdict.reason = "the pane tree filter did not take focus";
        fail(verdict.reason, "property");
      } else if (c.expect.exploratory) {
        const committed = snap.events.some((e) => e.type === "compositionend");
        if (!committed) {
          verdict.status = "unavailable";
          verdict.reason = "no compositionend arrived for the commit attempt";
        } else if (c.witness) {
          verdict.status = "witnessed";
          verdict.reason = "composition observed committing; no byte contract";
        }
      } else if (c.witness) {
        verdict.status = "witnessed";
        verdict.reason = "observed, no byte contract";
      } else if (widgetBytes !== (c.expect.widget ?? "") || ptyBytes !== (c.expect.pty ?? "")) {
        verdict.status = "failed";
        verdict.reason = `widget ${JSON.stringify(widgetBytes)} vs ${JSON.stringify(c.expect.widget)}; pty ${JSON.stringify(ptyBytes)} vs ${JSON.stringify(c.expect.pty)}`;
        fail(verdict.reason, "property");
      }
      const fixture = {
        header: {
          case: c.id,
          title: c.title,
          family: c.family,
          engine: summary.engine,
          engineVersion: summary.engineVersion,
          worktreeSha: summary.worktreeSha,
          producedBy: "trusted XTEST keys through xdotool in the desktop guest, read through the WebKit remote inspector, in chan-desktop",
          seam: "widget term.onData in the app plus raw PTY input (adapter plus widget)",
          derivation: c.source,
          recorder: recorderId,
          platform: `${process.platform}-${process.arch}`,
          layout: await guestLayout(),
          isTrustedAll: true,
        },
        setup: { program: c.program ?? "", programReply: programSetup.input, programBarrier: programSetup.reply, barrier: drained.reply, focused: snap.focused, paneTreeFocused: snap.paneTreeFocused, terms: snap.terms, ptyOffset: offset },
        steps: c.webkit.steps,
        domEvents: snap.events,
        observed: { widget: widgetBytes, pty: ptyBytes },
        contract: { widget: c.expect.widget, pty: c.expect.pty },
        verdict,
      };
      const schemaErrors = validateCaseFile(fixture);
      if (schemaErrors.length > 0) {
        fail(`schema: ${schemaErrors.join("; ")}`, "instrument");
        continue;
      }
      writeFileSync(`${a.out}/${c.id}.json`, `${JSON.stringify(fixture, null, 2)}\n`);
      summary.cases[c.id] = verdict.status;
    } finally {
      if (c.expect.paneTreeFocused) await xdo(["key", "Escape"]);
      if (c.restore) await drainPointerInput(transport, c.restore);
      }
  }
  summary.finished = new Date().toISOString();
  summary.counts = { preconditions: failKind("instrument"), properties: failKind("property") };
  const summaryErrors = validateRunSummary(summary, CASES.map((c) => c.id));
  if (summaryErrors.length > 0) throw new Error(`summary schema: ${summaryErrors.join("; ")}`);
  writeFileSync(`${a.out}/run-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  if (failKind("instrument") > 0) {
    console.error(`webkit-record: ${failKind("instrument")} instrument failure(s); results are inconclusive, not a product verdict`);
    process.exitCode = 3;
  } else if (failKind("property") > 0) {
    console.error(`webkit-record: failed cases: ${failures.filter((f) => f.kind === "property").map((f) => f.name).join(",")}`);
    process.exitCode = 10;
  } else {
    console.log(`webkit-record: ${Object.entries(summary.cases).map(([id, s]) => `${id}=${s}`).join(" ")}`);
  }

} catch (error) {
  console.error(String(error.message || error).replaceAll(transport.env.TERMINAL_FIXTURE_TOKEN, "[redacted]").replace(/([?&]t=)[^&\s"']*/g, "$1<token>"));
  process.exitCode = 3;
} finally {
  await transport.close();
}
