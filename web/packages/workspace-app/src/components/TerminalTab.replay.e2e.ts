import { expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalReplay")).parserTerminalModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { bytes as Buffer, caseName, emit, mountRealTerminal, observations, ReplaySocket, rpc, save, snapshot } from "../__tests__/terminalReplay";

async function assertWireProvenance() {
  const records = await rpc("records");
  expect(records.filter((entry: any) => entry.event === "failure")).toEqual([]);
  for (const peer of ReplaySocket.all) {
    const forwarded = records.filter((entry: any) => entry.event === "frame" && entry.direction === "forwarded" && entry.connection === peer.connection);
    expect(peer.deliveries.map(({ bytes, binary }) => ({ bytes, binary })), "wire forwarding equals actual client receipt")
      .toEqual(forwarded.map(({ bytes, binary }: any) => ({ bytes, binary })));
    for (const frame of forwarded) {
      const upstream = records.find((entry: any) => entry.event === "frame" && entry.direction === "received" && entry.connection === peer.connection && entry.frame === frame.source);
      expect(frame.binary).toBe(upstream.binary);
      expect(Buffer.from(frame.bytes, "base64"), "forwarded bytes match their independently recorded upstream source")
        .toEqual(Buffer.from(upstream.bytes, "base64").subarray(frame.offset, frame.offset + frame.length));
    }
  }
  return records;
}

if (caseName === "normal-screen") test("a normal-screen reconnect replays every retained row exactly once", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const result: Record<string, unknown> = { name: "normal-screen", status: "failed" };
  try {
    mounted = await mountRealTerminal(TerminalTab);
    await mounted.socket.ready();
    await emit("rows", { prefix: "RETAINED", count: 5000 });
    await emit("marker", { name: "NORMAL_BEFORE" });
    await mounted.socket.bytesInclude("MARKER:NORMAL_BEFORE\r\n");
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    const expected = emitted.toString().split("\r\n").filter(Boolean);
    expect(expected).toHaveLength(5001);
    const before = await snapshot("normal before cut");
    expect(before.active).toBe("normal");
    expect(before.normal.rows.filter(Boolean)).toEqual(expected);
    ReplaySocket.acknowledge = async (message) => {
      if (message.connection === 2 && message.type === "session") {
        await emit("rows", { prefix: "WITHHELD", count: 7 });
        await emit("marker", { name: "WITHHELD_END" });
        await rpc("upstream-marker", { connection: 2, marker: "MARKER:WITHHELD_END\r\n" });
        await rpc("ack", { connection: message.connection, frame: message.frame, drained: false });
      }
    };
    await rpc("arm", { boundary: "after-session", ordinal: 2 });
    mounted.socket.disconnect();
    const cut = await rpc("cut");
    expect(cut.boundary).toBe("after-session");
    expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(cut.replayForwarded).toBe(0);
    expect((await ReplaySocket.dial(2)).deliveries.map((frame) => frame.type)).toEqual(["session"]);
    const recoverySource = await rpc("fixture-log");
    const allEmitted = Buffer.from(recoverySource.bytes, "base64");
    const allExpected = allEmitted.toString().split("\r\n").filter(Boolean);
    expect(allExpected).toHaveLength(5009);
    expect(allExpected.slice(0, expected.length)).toEqual(expected);
    const recovery = await ReplaySocket.dial(3);
    await recovery.ready();
    const session = JSON.parse(Buffer.from(recovery.deliveries.find((frame) => frame.type === "session")!.bytes, "base64").toString());
    expect(session.seq).toBe(allEmitted.length);
    expect(session.replay_bytes, "full retained history follows the recovery session").toBe(allEmitted.length);
    expect(session.missed_bytes, "no bytes were lost from the retained history").toBe(0);
    const recovered = await snapshot("normal after cut");
    expect(recovered.active).toBe("normal");
    expect(recovered.normal.rows.filter(Boolean), "full replay preserves the baseline and recovers the withheld delta once").toEqual(allExpected);
    expect({ x: recovered.normal.cursorX, y: recovered.normal.cursorY, base: recovered.normal.baseY })
      .toEqual({ x: 0, y: 23, base: allExpected.length - 23 });
    const replay = Buffer.concat(recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(replay.subarray(0, allEmitted.length), "retained replay is the fixture's exact byte stream").toEqual(allEmitted);
    await emit("marker", { name: "NORMAL_AFTER" });
    await recovery.bytesInclude("MARKER:NORMAL_AFTER\r\n");
    const final = await snapshot("normal live output after replay");
    expect(final.normal.rows.filter(Boolean), "one prompt follows every retained row with no missed-bytes line")
      .toEqual([...allExpected, "MARKER:NORMAL_AFTER"]);
    const records = await assertWireProvenance();
    const connections = records.filter((entry: any) => entry.event === "connection");
    expect(connections.map((entry: any) => entry.connection)).toEqual([1, 2, 3]);
    expect(connections[1].query.since).toBe(String(emitted.length));
    expect(connections[1].query.generation).toBe(String(session.generation));
    expect(connections[2].query.since).toBe("0");
    expect(connections[2].query.generation).toBeUndefined();
    Object.assign(result, { status: "passed", cut, session, fixtureSha256: recoverySource.sha256, normalRows: allExpected.length,
      receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("normal-screen.json", result); }
  }
});

if (caseName === "alternate-screen") test("an alternate-screen reconnect preserves normal scrollback after a cut", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const result: Record<string, unknown> = { name: "alternate-screen", status: "failed" };
  try {
    mounted = await mountRealTerminal(TerminalTab);
    await mounted.socket.ready();
    await emit("rows", { prefix: "HISTORY", count: 5000 });
    await emit("marker", { name: "NORMAL_PROMPT" });
    await mounted.socket.bytesInclude("MARKER:NORMAL_PROMPT\r\n");
    const before = await snapshot("normal baseline");
    const source = await rpc("fixture-log");
    expect({ tty: source.hello.tty, raw: source.hello.raw, cols: source.hello.cols, rows: source.hello.rows })
      .toEqual({ tty: true, raw: true, cols: 80, rows: 24 });
    const expected = Buffer.from(source.bytes, "base64").toString().split("\r\n").filter(Boolean);
    expect(expected).toHaveLength(5001);
    expect(before.normal.rows.filter(Boolean), "all independently logged normal rows are parsed once").toEqual(expected);
    expect(before.active).toBe("normal");
    await emit("alternate", { enabled: true });
    await emit("redraw", { name: "BEFORE_CUT" });
    await mounted.socket.bytesInclude("SCREEN:BEFORE_CUT\r\n");
    const alternate = await snapshot("alternate before cut");
    expect(alternate.active).toBe("alternate");
    expect(alternate.normal).toEqual(before.normal);
    const alternateSource = await rpc("fixture-log");

    ReplaySocket.acknowledge = async (message) => {
      if (message.connection === 2 && message.type === "session") {
        await rpc("ack", { connection: message.connection, frame: message.frame, drained: false });
      }
    };
    await rpc("arm", { boundary: "after-session", ordinal: 2 });
    mounted.socket.disconnect();
    const cut = await rpc("cut");
    expect(cut.boundary).toBe("after-session");
    expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(cut.replayBytes).toBe(0);
    expect(cut.replayForwarded).toBe(0);
    const interrupted = await ReplaySocket.dial(2);
    expect(interrupted.deliveries.map((frame) => frame.type)).toEqual(["session"]);
    expect(interrupted.deliveries.every((frame) => frame.processed)).toBe(true);
    const recovery = await ReplaySocket.dial(3);
    await recovery.ready();
    const session = JSON.parse(Buffer.from(recovery.deliveries.find((frame) => frame.type === "session")!.bytes, "base64").toString());
    expect(session.replay_bytes, "alternate-screen prelude is not ring replay").toBe(0);
    expect(session.seq, "server cursor accounts for the fixture's exact emitted bytes").toBe(Buffer.from(alternateSource.bytes, "base64").length);
    expect(session.missed_bytes).toBe(0);
    const recovered = await snapshot("recovered alternate");
    expect(recovered.active).toBe("alternate");
    expect(recovered.normal, "the cut and empty replay preserve every normal row and cursor").toEqual(before.normal);
    await emit("redraw", { name: "RECOVERED" });
    await recovery.bytesInclude("SCREEN:RECOVERED\r\n");
    const redrawn = await snapshot("redrawn alternate");
    expect(redrawn.alternate.rows.filter(Boolean)).toEqual(["SCREEN:RECOVERED"]);
    await emit("alternate", { enabled: false });
    await emit("marker", { name: "FINAL_PROMPT" });
    await recovery.bytesInclude("MARKER:FINAL_PROMPT\r\n");
    const final = await snapshot("returned to normal prompt");
    expect(final.active).toBe("normal");
    expect(final.normal.rows.filter(Boolean), "history above the final prompt is intact").toEqual([...expected, "MARKER:FINAL_PROMPT"]);
    const records = await rpc("records");
    expect(records.filter((entry: any) => entry.event === "failure")).toEqual([]);
    const connections = records.filter((entry: any) => entry.event === "connection");
    expect(connections.map((entry: any) => entry.connection)).toEqual([1, 2, 3]);
    expect(connections[1].query.since).toBe(String(session.seq));
    expect(connections[1].query.generation).toBe(String(session.generation));
    expect(connections[2].query.since, "the page abandons the cursor of the interrupted attach").toBe("0");
    expect(connections[2].query.generation).toBeUndefined();
    for (const peer of ReplaySocket.all) {
      const forwarded = records.filter((entry: any) => entry.event === "frame" && entry.direction === "forwarded" && entry.connection === peer.connection);
      expect(peer.deliveries.map(({ bytes, binary }) => ({ bytes, binary })), "wire forwarding equals actual client receipt").toEqual(forwarded.map(({ bytes, binary }: any) => ({ bytes, binary })));
      for (const frame of forwarded) {
        const upstream = records.find((entry: any) => entry.event === "frame" && entry.direction === "received" && entry.connection === peer.connection && entry.frame === frame.source);
        expect(frame.binary).toBe(upstream.binary);
        expect(Buffer.from(frame.bytes, "base64"), "forwarded bytes match their independently recorded upstream source")
          .toEqual(Buffer.from(upstream.bytes, "base64").subarray(frame.offset, frame.offset + frame.length));
      }
    }
    const firstOutput = Buffer.concat(mounted.socket.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(firstOutput.subarray(0, Buffer.from(source.bytes, "base64").length), "pass-through bytes equal the fixture log").toEqual(Buffer.from(source.bytes, "base64"));
    Object.assign(result, { status: "passed", cut, session, fixtureSha256: source.sha256, normalRows: expected.length,
      receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("alternate-screen.json", result); }
  }
});
