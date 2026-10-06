import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FailureRecord } from "./failure-record.mjs";

test("a failed check retains slow requests, both page signals and socket frames", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "chan-failure-record-"));
  let now = 1_000;
  try {
    const record = new FailureRecord("deliberate-red", outDir, () => now, () => ({ cpu: "quota" }));
    record.startResources();
    const session = new EventEmitter();
    session.send = async () => {};
    const page = new EventEmitter();
    page.createCDPSession = async () => session;
    await record.observePage(page, "second-window");

    page.emit("console", { type: () => "warning", text: () => "waiting for page" });
    page.emit("pageerror", new Error("deliberate page error"));
    session.emit("Network.webSocketCreated", { requestId: "ws1", url: "ws://localhost/ws?t=secret" });
    session.emit("Network.webSocketHandshakeResponseReceived", { requestId: "ws1", response: { status: 101 } });
    session.emit("Network.webSocketFrameReceived", {
      requestId: "ws1",
      response: { payloadData: JSON.stringify({ type: "fs", event: { kind: "Removed", path: "", is_dir: true } }) },
    });
    const request = { method: () => "GET", url: () => "http://localhost/api/fs?dir=&t=secret" };
    page.emit("request", request);
    now += 5_100;
    page.emit("response", { request: () => request, status: () => 404 });
    page.emit("requestfinished", request);
    record.mark("check:failed", { reason: "deliberate failure" });
    const result = JSON.parse(readFileSync(record.write(), "utf8"));

    assert.equal(result.events.find((event) => event.type === "check:failed")?.reason, "deliberate failure");
    assert.equal(result.events.find((event) => event.type === "page:request")?.durationMs, 5_100);
    assert.equal(result.events.find((event) => event.type === "page:listing")?.status, 404);
    assert.equal(result.events.find((event) => event.type === "socket:frame")?.eventKind, "Removed");
    assert.equal(result.events.find((event) => event.type === "page:console")?.page, "second-window");
    assert.match(result.events.find((event) => event.type === "page:error")?.error ?? "", /deliberate page error/);
    assert.equal(result.events.find((event) => event.type === "guest:resources")?.cpu, "quota");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
