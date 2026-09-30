#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startTerminalCutProxy } from "./lib/terminal-cut-proxy.mjs";
import { startTerminalFixture } from "./lib/terminal-fixture.mjs";
import { launchServer, seedWorkspace, teardownServer } from "./lib/server.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const required = ["alternate-screen", "normal-screen", "keyboard-modes", "overflow", "attach-windows", "restart"];
const implemented = ["alternate-screen", "normal-screen"];
const selected = process.env.REPLAY_CASES?.split(",").filter(Boolean) ?? required;
const out = resolve(process.env.REPLAY_OUT ?? "terminal-replay-results");
mkdirSync(out, { recursive: false });
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const results = { required, selected, accepted: false, cases: [], limitations: ["painted pixels", "ghostty input", "native webview", "fd-store restoration"] };
const bin = resolve(process.env.CHAN_BIN ?? join(repo, "target/debug/chan"));
let activeStop;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    results.interrupted = signal;
    void Promise.resolve(activeStop?.()).finally(() => { save("results.json", results); process.exit(2); });
  });
}

async function runCase(name) {
  const caseOut = join(out, name);
  mkdirSync(caseOut);
  const save = (file, value) => writeFileSync(join(caseOut, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const outcome = { name, status: "not-run", reason: "no case result" };
  let server, fixture, proxy, control, runner, session, bearer, workspace;
  const serverLog = [];
  const redact = (line) => String(line).replace(/([?&]t=)[^\s&]+/g, "$1[redacted]").replaceAll(bearer ?? "\0", "[redacted]");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      try { await once(runner, "exit", { signal: AbortSignal.timeout(5000) }); }
      catch {
        runner.kill("SIGKILL");
        await once(runner, "exit", { signal: AbortSignal.timeout(5000) });
      }
    }
    if (fixture) {
      try { await fixture.send("stop"); } catch (error) { outcome.fixtureStop = redact(error.message); }
      await fixture.close();
      save("fixture-records.json", fixture.records);
    }
    if (proxy) {
      await proxy.close();
      save("proxy-records.json", proxy.records);
    }
    if (control) {
      control.closeAllConnections();
      await new Promise((done) => control.close(done));
    }
    if (server) await teardownServer(bin, server.child, workspace, server.chanHome, (line) => serverLog.push(redact(line)));
    save("server-log.json", serverLog);
  };
  activeStop = stop;

  try {
    workspace = seedWorkspace();
    server = launchServer(bin, workspace, (line) => serverLog.push(redact(line)));
    const upstream = new URL(await server.url);
    bearer = upstream.searchParams.get("t");
    assert(bearer, "server did not issue a bearer token");
    fixture = await startTerminalFixture({ logPath: join(caseOut, "fixture.bin"), deadlineMs: 20_000 });
    const response = await fetch(`${upstream.origin}/api/terminals`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "replay-check", command: "stty -opost -echo && " + fixture.command, env: fixture.env }),
    });
    assert.equal(response.status, 201, "create the owned PTY");
    session = (await response.json()).session;
    assert.equal(typeof session, "string");
    const hello = await fixture.ready();
    assert(hello.tty && hello.raw, "fixture needs a raw PTY");
    proxy = await startTerminalCutProxy({ targetUrl: upstream.origin, path: "/api/terminal/ws", session, deadlineMs: 20_000 });
    const controlToken = randomBytes(24).toString("hex");
    control = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${controlToken}`, "private controller");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { op, args = {} } = JSON.parse(Buffer.concat(chunks).toString());
        let result;
        if (op === "fixture") result = await fixture.send(args.op, args.args);
        else if (op === "arm") { proxy.arm(args); result = true; }
        else if (op === "ack") { proxy.acknowledge(args); result = true; }
        else if (op === "cut") result = await proxy.waitForCut();
        else if (op === "records") result = proxy.records;
        else if (op === "upstream-marker") result = await proxy.waitForRecord((entry) =>
          entry.event === "frame" && entry.direction === "received" && entry.connection === args.connection
          && Buffer.concat(proxy.records.filter((frame) => frame.event === "frame" && frame.direction === "received"
            && frame.connection === args.connection && frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")))
            .includes(Buffer.from(args.marker)));
        else if (op === "fixture-log") {
          const bytes = readFileSync(join(caseOut, "fixture.bin"));
          result = { bytes: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), hello };
        } else throw new Error("unknown controller operation");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: redact(error.message) }));
      }
    });
    control.listen(0, "127.0.0.1");
    await once(control, "listening");
    const pageUrl = new URL(proxy.url);
    pageUrl.searchParams.set("t", bearer);
    runner = spawn(process.execPath, [join(repo, "web/node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.replay.config.ts"], {
      cwd: join(repo, "web/packages/workspace-app"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHAN_REPLAY_URL: pageUrl.href, CHAN_REPLAY_SESSION: session, CHAN_REPLAY_OUT: caseOut, CHAN_REPLAY_CASE: name,
        CHAN_REPLAY_WS_PACKAGE: join(repo, "scripts/e2e/browser-smoke/package.json"),
        CHAN_REPLAY_CONTROL: `http://127.0.0.1:${control.address().port}`, CHAN_REPLAY_CONTROL_TOKEN: controlToken },
    });
    const output = [];
    runner.stdout.on("data", (chunk) => output.push(chunk));
    runner.stderr.on("data", (chunk) => output.push(chunk));
    const [code, signal] = await once(runner, "exit", { signal: AbortSignal.timeout(180_000) });
    writeFileSync(join(caseOut, "vitest.log"), redact(Buffer.concat(output).toString()), { flag: "wx" });
    outcome.runner = { code, signal };
    const resultPath = join(caseOut, `${name}.json`);
    if (existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      assert.equal(result.name, name, "case result identity");
      delete outcome.reason;
      Object.assign(outcome, result);
    }
  } catch (error) {
    outcome.error = redact(error.stack ?? error.message);
  } finally {
    try { await stop(); } catch (error) { outcome.cleanupError = redact(error.stack ?? error.message); }
    activeStop = undefined;
  }
  return outcome;
}

try {
  assert(selected.length > 0 && new Set(selected).size === selected.length, "select at least one distinct case");
  assert(selected.every((name) => required.includes(name)), "unknown required case");
  assert(existsSync(bin), "own debug chan binary missing");
  for (const name of selected) {
    const outcome = implemented.includes(name) ? await runCase(name) : { name, status: "not-run", reason: "case is not implemented" };
    results.cases.push(outcome);
    if (outcome.error || outcome.cleanupError || outcome.fixtureStop || outcome.status === "failed") break;
  }
} catch (error) {
  results.error = String(error.stack ?? error.message);
} finally {
  for (const name of required) {
    if (!results.cases.some((entry) => entry.name === name)) results.cases.push({ name, status: "not-run", reason: "not selected" });
  }
  results.accepted = !results.error && !results.interrupted
    && required.every((name) => {
      const entries = results.cases.filter((entry) => entry.name === name);
      return entries.length === 1 && entries[0].status === "passed" && entries[0].runner?.code === 0 && entries[0].runner.signal === null
        && !entries[0].error && !entries[0].cleanupError && !entries[0].fixtureStop;
    });
  save("results.json", results);
}
console.log(JSON.stringify({ out, accepted: results.accepted, cases: results.cases.map(({ name, status }) => ({ name, status })) }));
process.exitCode = results.accepted ? 0 : 2;
