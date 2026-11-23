import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchServer } from "./server.mjs";

function fakeServer(t, source, options) {
  const root = mkdtempSync(join(tmpdir(), "chan-server-lines-test-"));
  const bin = join(root, "fake-chan");
  writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const logged = [];
  const server = launchServer(bin, root, (line) => logged.push(line), options);
  const closed = once(server.child, "close");
  t.after(async () => {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill();
    await closed;
    rmSync(server.chanHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { ...server, logged, closed };
}

test("stderr records whole lines once, excludes stdout and remains live", async (t) => {
  const server = fakeServer(t, `
process.stdout.write("WARN terminal.ghostty stdout decoy\\n");
process.stderr.write("WARN terminal.");
setTimeout(() => {
  process.stderr.write("ghostty first\\nhttp://127.0.0.");
  setTimeout(() => {
    process.stderr.write("1:1234/?t=test-token\\n");
    setTimeout(() => process.stderr.write("WARN terminal.ghostty second\\r\\nfinal partial line"), 30);
  }, 30);
}, 30);
`);
  const lines = server.stderrLines;
  assert.equal(await server.url, "http://127.0.0.1:1234/?t=test-token");
  await server.closed;
  assert.equal(server.stderrLines, lines, "callers retain the live array");
  assert.deepEqual(lines, [
    "WARN terminal.ghostty first",
    "http://127.0.0.1:1234/?t=test-token",
    "WARN terminal.ghostty second",
    "final partial line",
  ]);
  assert.equal(lines.filter((line) => line.includes("terminal.ghostty")).length, 2);
  assert.equal(server.logged.length, 5, "both streams still reach the log callback");
});

test("a URL on stdout is discovered without entering stderr evidence", async (t) => {
  const server = fakeServer(t, 'process.stdout.write("http://127.0.0.1:1234/\\n");');
  assert.equal(await server.url, "http://127.0.0.1:1234/");
  await server.closed;
  assert.deepEqual(server.stderrLines, []);
});

test("an early exit includes an unterminated stderr diagnostic", async (t) => {
  const server = fakeServer(t, 'process.stderr.write("failed before URL"); process.exitCode = 7;');
  await assert.rejects(server.url, /chan serve exited early \(7\)\nfailed before URL/);
  await server.closed;
  assert.deepEqual(server.stderrLines, ["failed before URL"]);
});


test("launch environment overrides reach the child without replacing its private home", async (t) => {
  const server = fakeServer(t, `
process.stderr.write(JSON.stringify({ filter: process.env.RUST_LOG,
  home: process.env.CHAN_HOME, runtime: process.env.XDG_RUNTIME_DIR,
  handoff: process.env.CHAN_NO_DEVSERVER_HANDOFF }) + "\\n");
process.stdout.write("http://127.0.0.1:1234/\\n");
`, { env: { RUST_LOG: "warn,chan_server::extract=debug", CHAN_HOME: "/refused-home",
    XDG_RUNTIME_DIR: "/refused-runtime", CHAN_NO_DEVSERVER_HANDOFF: "0" } });
  await server.url;
  await server.closed;
  assert.deepEqual(JSON.parse(server.stderrLines[0]), {
    filter: "warn,chan_server::extract=debug", home: server.chanHome,
    runtime: join(server.chanHome, "runtime"), handoff: "1",
  });
});
