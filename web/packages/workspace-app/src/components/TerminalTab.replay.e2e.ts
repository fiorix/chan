import { expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalReplay")).parserTerminalModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { bytes as Buffer, caseName, emit, mountRealTerminal, observations, parsers, ReplaySocket, rpc, save, snapshot } from "../__tests__/terminalReplay";
import { pressInTerminal } from "../__tests__/terminalTab";

async function assertWireProvenance() {
  const received = ReplaySocket.all.map((peer) => ({ connection: peer.connection,
    deliveries: peer.deliveries.map(({ bytes, binary }) => ({ bytes, binary })) }));
  const records = await rpc("records");
  expect(records.filter((entry: any) => entry.event === "failure")).toEqual([]);
  for (const peer of received) {
    const forwarded = records.filter((entry: any) => entry.event === "frame" && entry.direction === "forwarded" && entry.connection === peer.connection).slice(0, peer.deliveries.length);
    expect(peer.deliveries, "every received frame equals its causally preceding forwarded frame")
      .toEqual(forwarded.map(({ bytes, binary }: any) => ({ bytes, binary })));
    for (const frame of forwarded) {
      const upstream = records.find((entry: any) => entry.event === "frame" && entry.direction === "received" && entry.connection === peer.connection && entry.frame === frame.source);
      expect(frame.binary).toBe(upstream.binary);
      // Encoded-byte equality avoids a deep assertion over millions of numeric properties on the page's event loop.
      expect(frame.bytes, "forwarded bytes match their independently recorded upstream source")
        .toBe(Buffer.from(Buffer.from(upstream.bytes, "base64").subarray(frame.offset, frame.offset + frame.length)).toString("base64"));
    }
  }
  observations.push({ event: "provenance", prefixes: received.map(({ connection, deliveries }) => ({ connection, count: deliveries.length })) });
  return records;
}

if (caseName === "keyboard-modes") test("negotiated key bytes survive cut replays and later replayed modes win", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const subcases: Array<Record<string, unknown>> = [];
  const result: Record<string, unknown> = { name: "keyboard-modes", status: "failed", subcases };
  let expectedKeys = "";
  const write = (text: string) => emit("bytes", { base64: Buffer.from(text).toString("base64") });
  const protocolValue = () => JSON.parse(JSON.stringify(mounted!.tab.keyboardProtocol));
  async function checkKeys(label: string, expected: string) {
    for (const modifier of [{ ctrlKey: true }, { shiftKey: true }]) {
      const key = pressInTerminal(parsers.at(-1)!, { key: "Enter", code: "Enter", ...modifier });
      expect(key.handled, "the page encodes the negotiated modified Enter").toBe(false);
    }
    expectedKeys += expected;
    const received = Buffer.from(await rpc("keys", { length: Buffer.from(expectedKeys).length }), "base64").toString();
    expect(received, "the raw PTY receives the exact negotiated key bytes").toBe(expectedKeys);
    observations.push({ event: "keys", label, expected: Buffer.from(expectedKeys).toString("base64"), received: Buffer.from(received).toString("base64"), protocol: protocolValue() });
  }
  async function cutAt(ordinal: number, queuedChange?: string) {
    ReplaySocket.acknowledge = async (message) => {
      if (message.connection === ordinal && message.type === "session") {
        if (queuedChange) {
          await write(queuedChange);
          await emit("marker", { name: "MODE_CHANGE_END" });
          await rpc("upstream-marker", { connection: ordinal, marker: "MARKER:MODE_CHANGE_END\r\n" });
        }
        await rpc("ack", { connection: ordinal, frame: message.frame, drained: false });
      }
    };
    await rpc("arm", { boundary: "after-session", ordinal });
    ReplaySocket.all.at(-1)!.disconnect();
    const cut = await rpc("cut");
    expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect((await ReplaySocket.dial(ordinal)).deliveries.map((frame) => frame.type)).toEqual(["session"]);
    const recovery = await ReplaySocket.dial(ordinal + 1);
    await recovery.ready();
    const parsed = await snapshot(`keyboard recovery ${ordinal}`);
    const session = JSON.parse(Buffer.from(recovery.deliveries.find((frame) => frame.type === "session")!.bytes, "base64").toString());
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    expect(session.seq, "recovery cursor matches every byte emitted by the fixture").toBe(emitted.length);
    if (session.replay_bytes > 0) {
      const replay = Buffer.concat(recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
      expect(Buffer.from(replay.subarray(0, session.replay_bytes)).toString("base64"), "retained replay is the fixture's exact suffix")
        .toBe(Buffer.from(emitted.subarray(emitted.length - session.replay_bytes)).toString("base64"));
      expect(session.missed_bytes).toBe(emitted.length - session.replay_bytes);
    }
    const records = await assertWireProvenance();
    const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === ordinal + 1);
    expect(dial.query.since).toBe("0");
    expect(dial.query.generation).toBeUndefined();
    return { cut, recovery, parsed, session };
  }
  try {
    mounted = await mountRealTerminal(TerminalTab);
    await mounted.socket.ready();
    const negotiation = "\x1b[>4;2m\x1b[>8u";
    const modified = "\x1b[27;5;13~\x1b[27;2;13~";
    const kitty = "\x1b[13;5u\x1b[13;2u";
    await write(negotiation);
    await emit("marker", { name: "MODES_BEFORE" });
    await mounted.socket.bytesInclude("MARKER:MODES_BEFORE\r\n");
    await snapshot("negotiated normal modes");
    const identity = mounted.tab.keyboardProtocol;
    const normalModes = protocolValue();
    expect(normalModes.xtermModifyOtherKeys).toBe(2);
    expect(normalModes.kitty.mainFlags).toBe(8);
    await checkKeys("normal before cut", modified);
    for (let index = 0; index < 12; index++) await write("\r".repeat(262144));
    await emit("marker", { name: "MODES_RETAINED" });
    await mounted.socket.bytesInclude("MARKER:MODES_RETAINED\r\n");
    await snapshot("normal padding consumed");
    const source = await rpc("fixture-log");
    const normal = await cutAt(2);
    expect(normal.session.seq).toBe(Buffer.from(source.bytes, "base64").length);
    expect(normal.session.replay_bytes).toBeGreaterThan(0);
    expect(normal.session.replay_bytes).toBeLessThan(normal.session.seq);
    const replay = Buffer.concat(normal.recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(replay.toString().includes(negotiation), "the old negotiation is outside the retained ring").toBe(false);
    expect(normal.parsed.active).toBe("normal");
    expect(mounted.tab.keyboardProtocol).toBe(identity);
    expect(protocolValue(), "normal replay restores negotiated state after RIS parsing").toEqual(normalModes);
    await checkKeys("normal after cut", modified);
    subcases.push({ name: "normal-screen", status: "passed", cut: normal.cut, session: normal.session, protocol: protocolValue() });

    await emit("alternate", { enabled: true });
    await write("\x1b[>4;0m\x1b[>8u");
    await emit("redraw", { name: "KEYBOARD_ALT" });
    await normal.recovery.bytesInclude("SCREEN:KEYBOARD_ALT\r\n");
    await snapshot("negotiated alternate modes");
    const alternateModes = protocolValue();
    expect(alternateModes.xtermModifyOtherKeys).toBe(0);
    expect(alternateModes.kitty.alternateFlags).toBe(8);
    await checkKeys("alternate before cut", kitty);
    const alternate = await cutAt(4);
    expect(alternate.session.replay_bytes).toBe(0);
    expect(alternate.parsed.active).toBe("alternate");
    expect(mounted.tab.keyboardProtocol).toBe(identity);
    expect(protocolValue(), "empty alternate replay preserves negotiated state").toEqual(alternateModes);
    await checkKeys("alternate after cut", kitty);
    subcases.push({ name: "alternate-screen", status: "passed", cut: alternate.cut, session: alternate.session, protocol: protocolValue() });

    await emit("alternate", { enabled: false });
    await write("\x1b[>4;2m");
    await emit("marker", { name: "CHANGE_BEFORE" });
    await alternate.recovery.bytesInclude("MARKER:CHANGE_BEFORE\r\n");
    await snapshot("normal modes before withheld change");
    await checkKeys("before replayed mode change", modified);
    const change = "\x1b[>4;0m\x1b[=9u";
    const changed = await cutAt(6, change);
    const changedReplay = Buffer.concat(changed.recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(changedReplay.toString().includes(change), "the mode change is actually in replay").toBe(true);
    expect(changed.parsed.active).toBe("normal");
    expect(mounted.tab.keyboardProtocol).toBe(identity);
    expect(protocolValue().xtermModifyOtherKeys, "replayed mode bytes override the saved protocol").toBe(0);
    expect(protocolValue().kitty.mainFlags).toBe(9);
    await checkKeys("after replayed mode change", kitty);
    subcases.push({ name: "replayed-change", status: "passed", cut: changed.cut, session: changed.session, protocol: protocolValue() });
    Object.assign(result, { status: "passed", receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("keyboard-modes.json", result); }
  }
});

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
    const records = await assertWireProvenance();
    const connections = records.filter((entry: any) => entry.event === "connection");
    expect(connections.map((entry: any) => entry.connection)).toEqual([1, 2, 3]);
    expect(connections[1].query.since).toBe(String(session.seq));
    expect(connections[1].query.generation).toBe(String(session.generation));
    expect(connections[2].query.since, "the page abandons the cursor of the interrupted attach").toBe("0");
    expect(connections[2].query.generation).toBeUndefined();
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
