import { expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { ghosttyFixture, ghosttyMode, pressInGhostty, typeInGhostty } from "../__tests__/ghosttyTab";
import { bytes as Buffer, caseName, emit, mountRealTerminal, observations, ReplaySocket, requiredSubcases, rpc, save, snapshot } from "../__tests__/terminalReplay";

async function assertWireProvenance() {
  const received = ReplaySocket.all.map((peer) => ({ connection: peer.connection,
    deliveries: peer.deliveries.map(({ bytes, binary }) => ({ bytes, binary })) }));
  const records = await rpc("records");
  expect(records.filter((entry: any) => entry.event === "failure")).toEqual([]);
  const upstreamFrames = new Map<string, any>(records.filter((entry: any) => entry.event === "frame" && entry.direction === "received")
    .map((entry: any) => [`${entry.connection}:${entry.frame}`, entry]));
  for (const peer of received) {
    const forwarded = records.filter((entry: any) => entry.event === "frame" && entry.direction === "forwarded" && entry.connection === peer.connection).slice(0, peer.deliveries.length);
    expect(peer.deliveries, "every received frame equals its causally preceding forwarded frame")
      .toEqual(forwarded.map(({ bytes, binary }: any) => ({ bytes, binary })));
    for (const frame of forwarded) {
      const upstream = upstreamFrames.get(`${peer.connection}:${frame.source}`);
      expect(frame.binary).toBe(upstream.binary);
      // Encoded-byte equality avoids a deep assertion over millions of numeric properties on the page's event loop.
      expect(frame.bytes, "forwarded bytes match their independently recorded upstream source")
        .toBe(Buffer.from(Buffer.from(upstream.bytes, "base64").subarray(frame.offset, frame.offset + frame.length)).toString("base64"));
    }
  }
  observations.push({ event: "provenance", prefixes: received.map(({ connection, deliveries }) => ({ connection, count: deliveries.length })) });
  return records;
}

if (caseName === "restart") test("a terminal restarted in place resets before showing its new generation once", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const result: Record<string, unknown> = { name: "restart", status: "failed" };
  try {
    mounted = await mountRealTerminal(TerminalTab);
    const socket = mounted.socket;
    await socket.ready();
    const sessionOf = (ordinal: number) => JSON.parse(Buffer.from(socket.deliveries.filter((frame) => frame.type === "session")[ordinal - 1].bytes, "base64").toString());
    const initialSession = sessionOf(1);
    const terminal = mounted.term;
    await emit("rows", { prefix: "OLD_GENERATION", count: 80 });
    await emit("marker", { name: "OLD_GENERATION_END" });
    await socket.bytesInclude("MARKER:OLD_GENERATION_END\r\n");
    await emit("barrier", { name: "OLD_GENERATION_DRAINED" });
    const initialSource = await rpc("fixture-log");
    const before = await snapshot("before in-place restart");
    expect(before.normal.rows.filter(Boolean)).toEqual(Buffer.from(initialSource.bytes, "base64").toString().split("\r\n").filter(Boolean));
    expect(before.normal.baseY, "the old generation includes scrollback").toBeGreaterThan(0);
    const boundary = socket.deliveries.length;
    const restart = await rpc("restart");
    expect(restart.status).toBe(204);
    expect(restart.session).toBe(initialSession.id);
    expect(restart.current.pid).not.toBe(restart.previous.pid);
    expect({ tty: restart.current.tty, raw: restart.current.raw }).toEqual({ tty: true, raw: true });
    const ready = await socket.ready(2);
    const nextSession = sessionOf(2);
    expect(nextSession.id, "restart retains the terminal id").toBe(initialSession.id);
    expect(nextSession.generation, "restart advances the generation").toBeGreaterThan(initialSession.generation);
    expect({ seq: nextSession.seq, replay: nextSession.replay_bytes, missed: nextSession.missed_bytes }).toEqual({ seq: 0, replay: 0, missed: 0 });
    const boundaryFrames = socket.deliveries.slice(boundary, ready.frame);
    const resetIndex = boundaryFrames.findIndex((frame) => frame.binary && Buffer.from(frame.bytes, "base64").toString() === "\x1bc");
    expect(resetIndex, "restart includes a reset before the new session").toBeGreaterThanOrEqual(0);
    expect(boundaryFrames.slice(0, resetIndex).every((frame) => frame.type === "resize"), "only outstanding resize acknowledgements may precede the restart reset").toBe(true);
    const restartFrames = boundaryFrames.slice(resetIndex);
    expect(restartFrames.map((frame) => frame.type), "reset precedes the second session and ready on the same socket").toEqual([null, "session", "ready"]);
    expect(Buffer.from(restartFrames[0].bytes, "base64").toString(), "the server sends exactly one RIS before the new session").toBe("\x1bc");
    expect(restartFrames.every((frame) => frame.processed)).toBe(true);
    const reset = await snapshot("new generation before output");
    expect(reset.active).toBe("normal");
    expect(reset.normal.rows.filter(Boolean), "restart removes all old rows before the new fixture writes").toEqual([]);
    expect({ x: reset.normal.cursorX, y: reset.normal.cursorY, base: reset.normal.baseY }).toEqual({ x: 0, y: 0, base: 0 });

    await emit("rows", { prefix: "NEW_GENERATION", count: 64 });
    await emit("marker", { name: "NEW_GENERATION_END" });
    await socket.bytesInclude("MARKER:NEW_GENERATION_END\r\n");
    const input = "restart-input\r";
    typeInGhostty(terminal, input);
    expect(Buffer.from(await rpc("keys", { length: Buffer.from(input).length }), "base64").toString(), "the new raw PTY receives input from the mounted page").toBe(input);
    await emit("marker", { name: "RESTART_LIVE" });
    await socket.bytesInclude("MARKER:RESTART_LIVE\r\n");
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    const expected = emitted.toString().split("\r\n").filter(Boolean);
    expect(expected).toHaveLength(66);
    const final = await snapshot("new generation with live input and output");
    expect(final.active).toBe("normal");
    expect(final.normal.rows.filter(Boolean), "only the new fixture's independently logged rows appear, exactly once").toEqual(expected);
    expect({ x: final.normal.cursorX, y: final.normal.cursorY, base: final.normal.baseY }).toEqual({ x: 0, y: 23, base: expected.length - 23 });
    const delivered = Buffer.concat(socket.deliveries.slice(boundary).filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(delivered.toString("base64"), "restart delivers only RIS and the new generation's exact byte stream").toBe(Buffer.concat([Buffer.from("\x1bc"), emitted]).toString("base64"));
    expect(await rpc("fixture-log", { initial: true }), "the old fixture's evidence remains unchanged").toEqual(initialSource);
    expect(mounted.tab.terminalSessionId).toBe(initialSession.id);
    expect(ghosttyFixture.terminals).toHaveLength(1);
    expect(ghosttyFixture.terminals[0]).toBe(terminal);
    expect(ReplaySocket.all).toHaveLength(1);
    expect(ReplaySocket.all[0]).toBe(socket);
    expect(socket.closed).toBe(false);
    expect(socket.deliveries.filter((frame) => ["session", "ready"].includes(frame.type ?? "")).map((frame) => frame.type)).toEqual(["session", "ready", "session", "ready"]);
    const records = await assertWireProvenance();
    expect(records.filter((entry: any) => entry.event === "connection").map((entry: any) => entry.connection)).toEqual([1]);
    Object.assign(result, { status: "passed", restart, initialSession, nextSession, initialFixtureSha256: initialSource.sha256,
      fixtureSha256: source.sha256, newRows: expected.length, readyFrame: ready.frame,
      receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin", "fixture-restarted-records.json", "fixture-restarted.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("restart.json", result); }
  }
});

if (caseName === "attach-windows") test("attach cuts preserve complete history and the appropriate resume cursor", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const subcases: Array<Record<string, unknown>> = requiredSubcases.map((name) => ({ name, status: "not-run", reason: "not implemented" }));
  const result: Record<string, unknown> = { name: "attach-windows", status: "failed", subcases };
  const passed = (name: string, detail: Record<string, unknown>) => {
    const entry = subcases.find((entry) => entry.name === name);
    expect(entry, "executed subcase must be required").toBeDefined();
    delete entry!.reason;
    Object.assign(entry!, { status: "passed", ...detail });
  };
  const sessionOf = (socket: ReplaySocket) => JSON.parse(Buffer.from(socket.deliveries.find((frame) => frame.type === "session")!.bytes, "base64").toString());
  const binaryOf = (socket: ReplaySocket) => Buffer.concat(socket.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
  try {
    mounted = await mountRealTerminal(TerminalTab);
    await mounted.socket.ready();
    await emit("rows", { prefix: "ATTACH", count: 5000 });
    await emit("marker", { name: "ATTACH_BASELINE" });
    await mounted.socket.bytesInclude("MARKER:ATTACH_BASELINE\r\n");
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    const rows = emitted.toString().split("\r\n").filter(Boolean);
    const baseline = await snapshot("ordinary attach baseline");
    expect(baseline.normal.rows.filter(Boolean)).toEqual(rows);
    const generation = sessionOf(mounted.socket).generation;

    await rpc("arm", { boundary: "before-session", ordinal: 2 });
    mounted.socket.disconnect();
    const beforeSessionCut = await rpc("cut");
    expect(beforeSessionCut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(beforeSessionCut.forwardedBytes).toBe(0);
    expect((await ReplaySocket.dial(2)).deliveries).toEqual([]);
    const beforeSessionRecovery = await ReplaySocket.dial(3);
    await beforeSessionRecovery.ready();
    const beforeSession = sessionOf(beforeSessionRecovery);
    expect({ seq: beforeSession.seq, replay: beforeSession.replay_bytes, missed: beforeSession.missed_bytes, generation: beforeSession.generation })
      .toEqual({ seq: emitted.length, replay: 0, missed: 0, generation });
    expect(binaryOf(beforeSessionRecovery).length).toBe(0);
    const recovered = await snapshot("ordinary before-session recovery");
    expect(recovered.active).toBe("normal");
    expect(recovered.normal, "a failed dial before session preserves all rows and cursor").toEqual(baseline.normal);
    let records = await assertWireProvenance();
    for (const ordinal of [2, 3]) {
      const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === ordinal);
      expect(dial.query.since).toBe(String(emitted.length));
      expect(dial.query.generation).toBe(String(generation));
    }
    passed("normal-before-session", { cut: beforeSessionCut, session: beforeSession });

    ReplaySocket.acknowledge = async (message) => {
      if (message.connection === 4 && message.type === "ready") {
        await emit("rows", { prefix: "SUFFIX", count: 7 });
        await emit("marker", { name: "SUFFIX_END" });
        await rpc("upstream-marker", { connection: 4, marker: "MARKER:SUFFIX_END\r\n" });
        await rpc("ack", { connection: 4, frame: message.frame, drained: true });
      }
    };
    await rpc("arm", { boundary: "after-ready", ordinal: 4 });
    beforeSessionRecovery.disconnect();
    const afterReadyCut = await rpc("cut");
    expect(afterReadyCut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(afterReadyCut.lastAcknowledged.drained).toBe(true);
    const cutSocket = await ReplaySocket.dial(4);
    expect(cutSocket.deliveries.some((frame) => frame.type === "ready" && frame.processed)).toBe(true);
    expect(binaryOf(cutSocket).length, "the new output is withheld after ready").toBe(0);
    const afterReadyRecovery = await ReplaySocket.dial(5);
    await afterReadyRecovery.ready();
    const afterReady = sessionOf(afterReadyRecovery);
    const allSource = await rpc("fixture-log");
    const allEmitted = Buffer.from(allSource.bytes, "base64");
    const suffix = Buffer.from(allEmitted.subarray(emitted.length));
    expect(afterReady.seq).toBe(allEmitted.length);
    expect(afterReady.generation).toBe(generation);
    expect(afterReady.missed_bytes).toBe(0);
    expect(afterReady.replay_bytes, "ordinary recovery advertises only the withheld suffix").toBe(suffix.length);
    expect(binaryOf(afterReadyRecovery).toString("base64"), "ordinary recovery delivers only the withheld suffix").toBe(suffix.toString("base64"));
    const final = await snapshot("ordinary after-ready recovery");
    const expected = allEmitted.toString().split("\r\n").filter(Boolean);
    expect(expected).toHaveLength(5009);
    expect(final.active).toBe("normal");
    expect(final.normal.rows.filter(Boolean), "suffix replay keeps the original history exactly once without a loss notice").toEqual(expected);
    expect({ x: final.normal.cursorX, y: final.normal.cursorY, base: final.normal.baseY })
      .toEqual({ x: 0, y: 23, base: expected.length - 23 });
    records = await assertWireProvenance();
    const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === 5);
    expect(dial.query.since, "ready preserves the consumed cursor for an ordinary resume").toBe(String(emitted.length));
    expect(dial.query.generation).toBe(String(generation));
    expect(records.filter((entry: any) => entry.event === "connection").map((entry: any) => entry.connection)).toEqual([1, 2, 3, 4, 5]);
    passed("normal-after-ready", { cut: afterReadyCut, session: afterReady, suffixBytes: suffix.length });

    await emit("bytes", { base64: Buffer.from("ATTACH_UTF8:\u03bb\r\n\x1b[31mATTACH_ESCAPE\x1b[0m\r\n").toString("base64") });
    await emit("marker", { name: "SPLIT_END" });
    await afterReadyRecovery.bytesInclude("MARKER:SPLIT_END\r\n");
    const splitSource = await rpc("fixture-log");
    const splitBytes = Buffer.from(splitSource.bytes, "base64");
    const splitText = splitBytes.toString();
    const splitRows = splitText.replace(/\x1b\[(?:31|0)m/g, "").split("\r\n").filter(Boolean);
    const splitBaseline = await snapshot("history before replay-prefix cuts");
    expect(splitBaseline.normal.rows.filter(Boolean)).toEqual(splitRows);
    const normalRows = (log: Uint8Array) => Buffer.from(log).toString().replace(/\x1b\[(?:31|0)m/g, "").split("\r\n").filter(Boolean);
    // Each variant cuts two redials. The first is cut after its session
    // while the fixture writes the variant's delta; the page had parsed
    // every byte, so that redial's replay is empty and its cut leaves the
    // page at the same cursor. The second redial echoes that cursor and the
    // generation, the server answers with the delta, and the proxy cuts it
    // at the variant's byte. The page then resumes from that byte, so a
    // character or a sequence the cut split completes on the recovery.
    const deltaOf = (tag: string) => ({
      body: `${tag} an interior row of the delta\r\n${tag} UTF8:\u03bb\r\n\x1b[31m${tag} ESCAPE\x1b[0m\r\n`,
      marker: `MARKER:${tag}_END\r\n`,
    });
    const bytesBefore = (text: string, of: string) => Buffer.from(text.slice(0, text.indexOf(of))).length;
    const variants: Array<{ name: string; tag: string; boundary: string; cutAt(text: string): number }> = [
      { name: "normal-interior-prefix", tag: "CUT_INTERIOR", boundary: "inside-replay", cutAt: () => 21 },
      { name: "normal-utf8-prefix", tag: "CUT_UTF8", boundary: "inside-replay", cutAt: (text) => bytesBefore(text, "\u03bb") + 1 },
      { name: "normal-escape-prefix", tag: "CUT_ESCAPE", boundary: "inside-replay", cutAt: (text) => bytesBefore(text, "\x1b[31m") + 2 },
      { name: "normal-before-ready", tag: "CUT_READY", boundary: "before-ready", cutAt: (text) => Buffer.from(text).length },
      { name: "normal-repeated-failed-dial", tag: "CUT_FAILED", boundary: "inside-replay", cutAt: () => 21 },
    ];
    let current = afterReadyRecovery;
    for (const variant of variants) {
      const cursor = Buffer.from((await rpc("fixture-log")).bytes, "base64").length;
      const { body, marker } = deltaOf(variant.tag);
      const delta = Buffer.from(body + marker);
      const cutAt = variant.cutAt(body + marker);
      const first = current.connection + 1;
      const second = first + 1;
      const failedDials = variant.name === "normal-repeated-failed-dial" ? [second + 1, second + 2] : [];
      let ackTail = Promise.resolve();
      let delivered = 0;
      ReplaySocket.acknowledge = (message) => {
        if (message.connection !== first && message.connection !== second) return Promise.resolve();
        ackTail = ackTail.then(async () => {
          if (message.connection === first && message.type === "session") {
            await emit("bytes", { base64: Buffer.from(body).toString("base64") });
            await emit("marker", { name: `${variant.tag}_END` });
            await rpc("upstream-marker", { connection: first, marker });
            await rpc("ack", { connection: first, frame: message.frame, drained: false });
          } else if (message.connection === second) {
            if (message.binary) delivered += Buffer.from(message.bytes, "base64").length;
            if (message.binary && delivered === cutAt) {
              await rpc("ack", { connection: second, frame: message.frame, drained: true });
            }
          }
        });
        return ackTail;
      };
      await rpc("arm-sequence", { arms: [
        { boundary: "after-session", ordinal: first },
        { boundary: variant.boundary, ordinal: second, ...(variant.boundary === "inside-replay" ? { bytes: cutAt } : {}) },
        ...failedDials.map((ordinal) => ({ boundary: "before-session", ordinal })),
      ] });
      current.disconnect();
      const cuts = await rpc("cuts");
      const log = Buffer.from((await rpc("fixture-log")).bytes, "base64");
      expect(Buffer.from(log.subarray(cursor)).toString("base64"), "the fixture wrote the delta while the first redial was held")
        .toBe(delta.toString("base64"));
      expect(cuts).toHaveLength(2 + failedDials.length);
      expect(cuts[0].boundary).toBe("after-session");
      expect(cuts[0].replayBytes, "the first redial's delta is empty: the page had parsed every byte").toBe(0);
      expect(cuts[0].replayForwarded).toBe(0);
      expect(cuts[1].boundary).toBe(variant.boundary);
      expect(cuts[1].replayBytes, "the second redial's delta is what the fixture wrote while the first was held").toBe(delta.length);
      expect(cuts[1].replayForwarded).toBe(cutAt);
      expect(cuts[1].lastAcknowledged.drained).toBe(true);
      for (const cut of cuts) expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
      expect((await ReplaySocket.dial(first)).deliveries.map((frame) => frame.type)).toEqual(["session"]);
      const interrupted = await ReplaySocket.dial(second);
      expect(interrupted.deliveries.some((frame) => frame.type === "ready")).toBe(false);
      expect(binaryOf(interrupted).toString("base64"), "the interrupted page receives the exact requested prefix")
        .toBe(Buffer.from(delta.subarray(0, cutAt)).toString("base64"));
      if (variant.name === "normal-utf8-prefix") {
        expect(delta[cutAt - 1]).toBe(0xce);
        expect(delta[cutAt]).toBe(0xbb);
      } else if (variant.name === "normal-escape-prefix") {
        expect(Buffer.from(delta.subarray(cutAt - 2, cutAt)).toString()).toBe("\x1b[");
        expect(delta[cutAt]).toBe(0x33);
      }
      for (const ordinal of failedDials) {
        expect((await ReplaySocket.dial(ordinal)).deliveries).toEqual([]);
        expect(cuts.find((cut: any) => cut.connection === ordinal).forwardedBytes).toBe(0);
      }
      const recoveryOrdinal = second + failedDials.length + 1;
      current = await ReplaySocket.dial(recoveryOrdinal);
      await current.ready();
      const session = sessionOf(current);
      expect({ seq: session.seq, replay: session.replay_bytes, missed: session.missed_bytes, generation: session.generation })
        .toEqual({ seq: cursor + delta.length, replay: delta.length - cutAt, missed: 0, generation });
      expect(binaryOf(current).toString("base64"), "the recovery resumes the delta at the byte the cut stopped at")
        .toBe(Buffer.from(delta.subarray(cutAt)).toString("base64"));
      const expected = normalRows(log);
      const parsed = await snapshot(`${variant.name} recovery`);
      expect(parsed.active).toBe("normal");
      expect(parsed.normal.rows.filter(Boolean), "each row once, with the character and the sequence the cut split whole")
        .toEqual(expected);
      expect({ x: parsed.normal.cursorX, y: parsed.normal.cursorY, base: parsed.normal.baseY })
        .toEqual({ x: 0, y: 23, base: expected.length - 23 });
      records = await assertWireProvenance();
      const resumed = String(cursor + cutAt);
      const echoed: Array<[number, string]> = [[second, String(cursor)], ...failedDials.map((ordinal): [number, string] => [ordinal, resumed]),
        [recoveryOrdinal, resumed]];
      for (const [ordinal, since] of echoed) {
        const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === ordinal);
        expect(dial.query.since, `dial ${ordinal} echoes the position the page parsed`).toBe(since);
        expect(dial.query.generation).toBe(String(generation));
      }
      passed(variant.name, { cuts, session, prefixBytes: cutAt, deltaBytes: delta.length });
    }
    passed("normal-second-cut", { variants: variants.map((variant) => variant.name) });
    const cutRows = normalRows(Buffer.from((await rpc("fixture-log")).bytes, "base64"));
    const cutBaseline = await snapshot("history after replay-prefix cuts");
    expect(cutBaseline.normal.rows.filter(Boolean)).toEqual(cutRows);

    await emit("alternate", { enabled: true });
    await emit("bytes", { base64: Buffer.from("\x1b[?1h\x1b[?2004h\x1b[>4;2m\x1b[>8u").toString("base64") });
    await emit("redraw", { name: "ATTACH_ALT_BASE" });
    await current.bytesInclude("SCREEN:ATTACH_ALT_BASE\r\n");
    const alternateBaseline = await snapshot("alternate attach baseline");
    expect(alternateBaseline.active).toBe("alternate");
    const protocol = mounted.tab.keyboardProtocol;
    const protocolValue = JSON.parse(JSON.stringify(protocol));
    // A remount replaces the page's widget, so each reading takes the current one.
    const term = () => mounted!.term;
    // The core reads only the screen that shows, so the normal screen is read
    // once the program leaves the alternate one; leaving restores the cursor
    // that entering saved. The program then enters it again, which clears
    // the alternate screen and keeps every mode and the keyboard protocol, so
    // the next arm starts on the alternate screen with the modes it set.
    async function normalAfterExit(name: string) {
      await emit("alternate", { enabled: false });
      await current.bytesInclude("\x1b[?1049l");
      const left = await snapshot(`${name} normal screen`);
      await emit("alternate", { enabled: true });
      await emit("redraw", { name: `${name}-again` });
      await current.bytesInclude(`SCREEN:${name}-again\r\n`);
      return left;
    }
    const entered = await normalAfterExit("ATTACH_ALT_BASE");
    expect(entered.active).toBe("normal");
    expect(entered.normal, "entering the alternate screen preserves the normal history and cursor").toEqual(cutBaseline.normal);
    let expectedKeys = "";
    async function alternateKeys(label: string) {
      for (const modifier of [{ ctrlKey: true }, { shiftKey: true }]) {
        expect(pressInGhostty(term(), { key: "Enter", code: "Enter", ...modifier }).defaultPrevented).toBe(true);
      }
      expectedKeys += "\x1b[27;5;13~\x1b[27;2;13~";
      expect(Buffer.from(await rpc("keys", { length: Buffer.from(expectedKeys).length }), "base64").toString(), label).toBe(expectedKeys);
    }
    await alternateKeys("alternate keys before cuts");
    // Each arm names the dials it cuts, in order, and the dial that recovers.
    // A redial echoes the position the page parsed and the live generation;
    // a fresh dial is `since=0` with no generation. On the alternate screen
    // the server continues a redial's view: the raw delta from its cursor,
    // empty here since the page parsed every byte, and no prelude or mode
    // reassert, so the view keeps its screen. A socket that closed between
    // a redial's session and its ready leaves the page where that replay
    // stopped, so the next dial is a redial from there too; a cut before the
    // session leaves the next dial as it was. Only a new widget dials fresh:
    // the remount arms remount the tab, whose fresh dial replays no ring
    // bytes and gets the prelude, which clears the alternate screen, then the
    // reassert of the modes the program enabled. That replay continued no
    // view, so after its cut the page dials fresh again. The remount arms run
    // last, since a tab remounted on the alternate screen holds no normal
    // history.
    type Dial = "redial" | "fresh";
    const sentTo = (dial: Dial) => dial === "fresh" ? ["\x1b[?1049h\x1b[2J\x1b[H", "\x1b[?1h\x1b[?2004h"] : [];
    const sentLabel = (dial: Dial) => dial === "fresh"
      ? "a fresh dial on the alternate screen gets the prelude, then the mode reassert"
      : "a redial on the alternate screen continues its view: no prelude and no mode reassert";
    const alternateVariants: Array<{ name: string; remount?: true; cuts: Array<{ dial: Dial; boundary: string; frames?: number }>; recovery: Dial }> = [
      { name: "alternate-before-session", cuts: [{ dial: "redial", boundary: "before-session" }], recovery: "redial" },
      { name: "alternate-before-ready", cuts: [{ dial: "redial", boundary: "before-ready" }], recovery: "redial" },
      { name: "alternate-after-ready", cuts: [{ dial: "redial", boundary: "after-ready" }], recovery: "redial" },
      { name: "alternate-second-cut", cuts: [{ dial: "redial", boundary: "after-session" },
        { dial: "redial", boundary: "before-session" }], recovery: "redial" },
      { name: "alternate-repeated-failed-dial", cuts: [{ dial: "redial", boundary: "after-session" },
        { dial: "redial", boundary: "before-session" }, { dial: "redial", boundary: "before-session" }], recovery: "redial" },
      { name: "alternate-after-prelude", remount: true, cuts: [{ dial: "fresh", boundary: "after-replay-frame", frames: 1 }], recovery: "fresh" },
      { name: "alternate-after-modes", remount: true, cuts: [{ dial: "fresh", boundary: "after-replay-frame", frames: 2 }], recovery: "fresh" },
    ];
    for (const variant of alternateVariants) {
      const first = current.connection + 1;
      const recoveryOrdinal = first + variant.cuts.length;
      const source = await rpc("fixture-log");
      const seq = Buffer.from(source.bytes, "base64").length;
      const before = await snapshot(`${variant.name} before its cuts`);
      expect(before.active).toBe("alternate");
      let ackTail = Promise.resolve();
      ReplaySocket.acknowledge = (message) => {
        const plan = variant.cuts[message.connection - first];
        if (!plan) return Promise.resolve();
        ackTail = ackTail.then(async () => {
          const atBoundary = plan.boundary === "before-ready"
            || (plan.boundary === "after-replay-frame" && message.frame === 1 + plan.frames!)
            || (plan.boundary === "after-ready" && message.type === "ready")
            || (plan.boundary === "after-session" && message.type === "session");
          if (atBoundary) {
            await rpc("ack", { connection: message.connection, frame: message.frame, drained: true });
          }
        });
        return ackTail;
      };
      await rpc("arm-sequence", { arms: variant.cuts.map((plan, index) => ({ boundary: plan.boundary, ordinal: first + index, frames: plan.frames })) });
      if (variant.remount) await mounted.remount();
      else current.disconnect();
      const cuts = await rpc("cuts");
      expect(cuts.map((cut: any) => [cut.connection, cut.boundary])).toEqual(variant.cuts.map((plan, index) => [first + index, plan.boundary]));
      for (const [index, plan] of variant.cuts.entries()) {
        const cut = cuts[index];
        const interrupted = await ReplaySocket.dial(first + index);
        const sent = sentTo(plan.dial);
        expect(cut.replayBytes, plan.dial === "fresh" ? "a fresh dial on the alternate screen replays no ring bytes"
          : "a redial's delta is empty once the page parsed every byte").toBe(0);
        expect(cut.replayForwarded).toBe(0);
        expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
        if (plan.boundary === "before-session") {
          expect(interrupted.deliveries).toEqual([]);
        } else if (plan.boundary === "after-session") {
          expect(interrupted.deliveries.map((frame) => frame.type)).toEqual(["session"]);
        } else if (plan.boundary === "after-replay-frame") {
          expect(binaryOf(interrupted).toString(), "the counted cut delivers exactly the selected prelude or mode prefix")
            .toBe(sent.slice(0, plan.frames).join(""));
          expect(interrupted.deliveries.map((frame) => frame.type)).toEqual(["session", ...Array(plan.frames).fill(null)]);
          expect(cut.upstreamFrame, "the cut is at the counted frame, before ready").toBe(1 + plan.frames!);
          expect(cut.lastAcknowledged).toEqual({ frame: 1 + plan.frames!, drained: true });
        } else {
          expect(binaryOf(interrupted).toString(), sentLabel(plan.dial)).toBe(sent.join(""));
          expect(cut.upstreamFrame, "ready follows the session and what the server sends this dial").toBe(2 + sent.length);
          expect(cut.lastAcknowledged.drained).toBe(true);
          expect(interrupted.deliveries.some((frame) => frame.type === "ready")).toBe(plan.boundary === "after-ready");
        }
      }
      current = await ReplaySocket.dial(recoveryOrdinal);
      await current.ready();
      const session = sessionOf(current);
      expect({ seq: session.seq, replay: session.replay_bytes, missed: session.missed_bytes, generation: session.generation })
        .toEqual({ seq, replay: 0, missed: 0, generation });
      expect(binaryOf(current).toString(), sentLabel(variant.recovery)).toBe(sentTo(variant.recovery).join(""));
      const parsed = await snapshot(`${variant.name} recovery`);
      expect(parsed.active).toBe("alternate");
      if (variant.recovery === "fresh") {
        expect(parsed.alternate.rows.filter(Boolean), "the remounted view recovers onto an empty alternate screen").toEqual([]);
        expect({ x: parsed.alternate.cursorX, y: parsed.alternate.cursorY }, "the remounted view recovers with the cursor at home").toEqual({ x: 0, y: 0 });
      } else {
        expect(parsed.alternate, "a continued view keeps its alternate screen and cursor").toEqual(before.alternate);
      }
      expect(mounted.tab.keyboardProtocol).toBe(protocol);
      expect(JSON.parse(JSON.stringify(mounted.tab.keyboardProtocol))).toEqual(protocolValue);
      expect(ghosttyMode(term(), 1)).toBe(true);
      expect(ghosttyMode(term(), 2004)).toBe(true);
      await alternateKeys(`${variant.name} keys`);
      records = await assertWireProvenance();
      const made = [...variant.cuts.map((plan) => plan.dial), variant.recovery];
      const dials = records.filter((entry: any) => entry.event === "connection" && entry.connection >= first && entry.connection <= recoveryOrdinal);
      expect(dials.map((dial: any) => dial.connection)).toEqual(made.map((_, index) => first + index));
      for (const [index, dial] of dials.entries()) {
        expect(dial.query.since, `dial ${dial.connection} is a ${made[index]} dial`).toBe(made[index] === "fresh" ? "0" : String(seq));
        expect(dial.query.generation).toBe(made[index] === "fresh" ? undefined : String(generation));
      }
      await emit("redraw", { name: variant.name });
      await current.bytesInclude(`SCREEN:${variant.name}\r\n`);
      const redrawn = await snapshot(`${variant.name} redraw`);
      expect(redrawn.alternate.rows.filter(Boolean)).toEqual([`SCREEN:${variant.name}`]);
      const left = await normalAfterExit(variant.name);
      expect(left.active).toBe("normal");
      if (variant.remount) {
        expect({ rows: left.normal.rows.filter(Boolean), base: left.normal.baseY },
          "a tab remounted on the alternate screen holds no normal history: its fresh dial replays no ring bytes there")
          .toEqual({ rows: [], base: 0 });
      } else {
        expect(left.normal, "the cuts, the recovery and the redraw preserve the normal history and cursor").toEqual(cutBaseline.normal);
      }
      passed(variant.name, { cuts, session, dials: made, protocol: protocolValue });
    }
    await emit("alternate", { enabled: false });
    await emit("bytes", { base64: Buffer.from("\x1b[?1l\x1b[?2004l").toString("base64") });
    await emit("marker", { name: "ATTACH_NORMAL_RETURN" });
    await current.bytesInclude("MARKER:ATTACH_NORMAL_RETURN\r\n");
    const returned = await snapshot("normal prompt after all alternate cuts");
    expect(returned.active).toBe("normal");
    expect(returned.normal.rows.filter(Boolean), "the remounted tab's normal screen holds the prompt only").toEqual(["MARKER:ATTACH_NORMAL_RETURN"]);
    await assertWireProvenance();
    const finalSource = await rpc("fixture-log");
    const missing = subcases.filter((entry) => entry.status !== "passed").map((entry) => entry.name);
    Object.assign(result, { status: missing.length ? "not-run" : "passed", reason: missing.length ? "required subcases are not implemented" : undefined,
      fixtureSha256: finalSource.sha256, receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("attach-windows.json", result); }
  }
});

if (caseName === "overflow") test("an overflow replay after a cut resets the interrupted replay and retains one exact loss notice", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const result: Record<string, unknown> = { name: "overflow", status: "failed" };
  try {
    mounted = await mountRealTerminal(TerminalTab);
    await mounted.socket.ready();
    await emit("rows", { prefix: "EVICTED", count: 8 });
    await emit("marker", { name: "OLD_PROMPT" });
    await mounted.socket.bytesInclude("MARKER:OLD_PROMPT\r\n");
    const old = await snapshot("old rows before ring overflow");
    expect(old.normal.rows.filter(Boolean)).toHaveLength(9);
    // Carriage returns fill the byte ring without exhausting the parser's row
    // history. Padding sits on both sides of the retained rows so the first
    // run evicts the old markers while keeping the retained rows past the
    // ring's start and ahead of the cut inside the remounted dial's replay.
    const pad = Buffer.from("\r".repeat(262144)).toString("base64");
    for (let index = 0; index < 5; index++) await emit("bytes", { base64: pad });
    await emit("rows", { prefix: "SURVIVES", count: 64 });
    for (let index = 0; index < 5; index++) await emit("bytes", { base64: pad });
    await emit("marker", { name: "OVERFLOW_END" });
    await mounted.socket.bytesInclude("MARKER:OVERFLOW_END\r\n");
    const before = await snapshot("overflow before cut");
    expect(before.normal.rows.filter(Boolean).slice(0, 9), "evicted rows are still in the page before recovery").toEqual(old.normal.rows.filter(Boolean));
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    // A redial would resume from the position the page parsed and miss
    // nothing, so the tab remounts: its new widget's dial asks for the whole
    // ring, which the overflow has cut to its tail. That dial is cut inside
    // its replay once the retained SURVIVES rows have reached the new widget;
    // its replay continued no view, so the page dials fresh again and resets
    // that interrupted replay before writing the notice and the retained ring.
    const cutAt = 900_000;
    let forwarded = 0;
    let ackTail = Promise.resolve();
    ReplaySocket.acknowledge = (message) => {
      if (message.connection !== 2 || !message.binary) return Promise.resolve();
      ackTail = ackTail.then(async () => {
        forwarded += Buffer.from(message.bytes, "base64").length;
        if (forwarded === cutAt) {
          await rpc("ack", { connection: 2, frame: message.frame, drained: true });
        }
      });
      return ackTail;
    };
    await rpc("arm", { boundary: "inside-replay", ordinal: 2, bytes: cutAt });
    await mounted.remount();
    const cut = await rpc("cut");
    expect(cut.boundary).toBe("inside-replay");
    expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(cut.replayForwarded).toBe(cutAt);
    expect(cut.replayBytes).toBeGreaterThan(cutAt);
    expect(cut.lastAcknowledged.drained).toBe(true);
    const interrupted = await ReplaySocket.dial(2);
    expect(interrupted.deliveries.some((frame) => frame.type === "ready")).toBe(false);
    const interruptedReplay = Buffer.concat(interrupted.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(interruptedReplay.length).toBe(cutAt);
    expect(interruptedReplay.toString(), "retained rows reached the new widget before the cut").toContain("SURVIVES:00000071\r\n");
    expect(interruptedReplay.toString(), "the cut stopped inside the replay, before its end").not.toContain("MARKER:OVERFLOW_END\r\n");
    const recovery = await ReplaySocket.dial(3);
    await recovery.ready();
    const session = JSON.parse(Buffer.from(recovery.deliveries.find((frame) => frame.type === "session")!.bytes, "base64").toString());
    const replay = Buffer.concat(recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.length).toBeLessThan(emitted.length);
    expect(session.seq).toBe(emitted.length);
    expect(session.replay_bytes, "advertised replay count equals the bytes actually delivered").toBe(replay.length);
    const missed = emitted.length - replay.length;
    expect(session.missed_bytes, "loss count is independently derived from emitted and delivered bytes").toBe(missed);
    const retained = Buffer.from(emitted.subarray(missed));
    expect(replay.toString("base64"), "the delivered replay is the exact retained fixture suffix").toBe(retained.toString("base64"));
    expect(retained[0], "ring eviction ends within the padding, before the retained rows").toBe(13);
    const rows = retained.toString().replace(/\r(?!\n)/g, "").split("\r\n").filter(Boolean);
    expect(rows).toHaveLength(65);
    const notice = `terminal replay missed ${missed} bytes`;
    const recovered = await snapshot("overflow after cut");
    expect(recovered.active).toBe("normal");
    expect(recovered.normal.rows.filter(Boolean), "one correctly counted notice survives above every retained row, with none repeated from the interrupted replay").toEqual([notice, ...rows]);
    await emit("marker", { name: "OVERFLOW_LIVE" });
    await recovery.bytesInclude("MARKER:OVERFLOW_LIVE\r\n");
    const final = await snapshot("overflow live suffix");
    expect(final.normal.rows.filter(Boolean)).toEqual([notice, ...rows, "MARKER:OVERFLOW_LIVE"]);
    const records = await assertWireProvenance();
    for (const ordinal of [2, 3]) {
      const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === ordinal);
      expect(dial.query.since, `dial ${ordinal} asks for the whole ring`).toBe("0");
      expect(dial.query.generation).toBeUndefined();
    }
    Object.assign(result, { status: "passed", cut, session, emittedBytes: emitted.length, replayBytes: replay.length,
      missedBytes: missed, retainedRows: rows.length, fixtureSha256: source.sha256,
      receipts: ["client-records.json", "proxy-records.json", "fixture-records.json", "fixture.bin"] });
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    try { await mounted?.close(); } finally { save("client-records.json", observations); save("overflow.json", result); }
  }
});

if (caseName === "keyboard-modes") test("negotiated key bytes survive cut replays and later replayed modes win", async () => {
  let mounted: Awaited<ReturnType<typeof mountRealTerminal>> | undefined;
  const subcases: Array<Record<string, unknown>> = [];
  const result: Record<string, unknown> = { name: "keyboard-modes", status: "failed", subcases };
  let expectedKeys = "";
  const write = (text: string) => emit("bytes", { base64: Buffer.from(text).toString("base64") });
  const protocolValue = () => JSON.parse(JSON.stringify(mounted!.tab.keyboardProtocol));
  async function checkKeys(label: string, expected: string) {
    for (const modifier of [{ ctrlKey: true }, { shiftKey: true }]) {
      const key = pressInGhostty(mounted!.term, { key: "Enter", code: "Enter", ...modifier });
      expect(key.defaultPrevented, "the page encodes the negotiated modified Enter").toBe(true);
    }
    expectedKeys += expected;
    const received = Buffer.from(await rpc("keys", { length: Buffer.from(expectedKeys).length }), "base64").toString();
    expect(received, "the raw PTY receives the exact negotiated key bytes").toBe(expectedKeys);
    observations.push({ event: "keys", label, expected: Buffer.from(expectedKeys).toString("base64"), received: Buffer.from(received).toString("base64"), protocol: protocolValue() });
  }
  /// Cut dial `ordinal` after its session and read the dial that recovers.
  /// A `redial` cuts the page's next redial, which resumes from the position
  /// it parsed, as the recovery does. A `remount` remounts the tab: its new
  /// widget's dial asks for the whole ring, and so does the recovery, since
  /// the cut replay continued no view.
  async function cutAt(ordinal: number, dial: "redial" | "remount", queuedChange?: string) {
    const cursor = Buffer.from((await rpc("fixture-log")).bytes, "base64").length;
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
    if (dial === "remount") await mounted!.remount();
    else ReplaySocket.all.at(-1)!.disconnect();
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
    if (dial === "redial") {
      expect(session.replay_bytes, "a redial's replay is what the fixture wrote after the position the page parsed").toBe(emitted.length - cursor);
    }
    if (session.replay_bytes > 0) {
      const replay = Buffer.concat(recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
      expect(Buffer.from(replay.subarray(0, session.replay_bytes)).toString("base64"), "retained replay is the fixture's exact suffix")
        .toBe(Buffer.from(emitted.subarray(emitted.length - session.replay_bytes)).toString("base64"));
    }
    expect(session.missed_bytes, dial === "redial" ? "a redial from the parsed position misses nothing"
      : "a whole-ring replay misses what the ring dropped").toBe(dial === "redial" ? 0 : emitted.length - session.replay_bytes);
    const records = await assertWireProvenance();
    for (const connection of [ordinal, ordinal + 1]) {
      const made = records.find((entry: any) => entry.event === "connection" && entry.connection === connection);
      expect(made.query.since, `dial ${connection} is a ${dial === "redial" ? "redial from the parsed position" : "fresh dial"}`)
        .toBe(dial === "redial" ? String(cursor) : "0");
      expect(made.query.generation).toBe(dial === "redial" ? String(session.generation) : undefined);
    }
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
    const normal = await cutAt(2, "remount");
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
    const alternate = await cutAt(4, "redial");
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
    const changed = await cutAt(6, "redial", change);
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

if (caseName === "normal-screen") test("a normal-screen reconnect after a cut shows every row exactly once", async () => {
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
    expect(session.replay_bytes, "the recovery replays the delta withheld behind the cut redial").toBe(allEmitted.length - emitted.length);
    expect(session.missed_bytes, "no bytes were lost from the retained history").toBe(0);
    const recovered = await snapshot("normal after cut");
    expect(recovered.active).toBe("normal");
    expect(recovered.normal.rows.filter(Boolean), "the page keeps the baseline and shows the withheld delta once").toEqual(allExpected);
    expect({ x: recovered.normal.cursorX, y: recovered.normal.cursorY, base: recovered.normal.baseY })
      .toEqual({ x: 0, y: 23, base: allExpected.length - 23 });
    const replay = Buffer.concat(recovery.deliveries.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.bytes, "base64")));
    expect(replay.subarray(0, session.replay_bytes), "the replay is the fixture's exact bytes after the parsed position")
      .toEqual(allEmitted.subarray(emitted.length));
    await emit("marker", { name: "NORMAL_AFTER" });
    await recovery.bytesInclude("MARKER:NORMAL_AFTER\r\n");
    const final = await snapshot("normal live output after replay");
    expect(final.normal.rows.filter(Boolean), "one prompt follows every retained row with no missed-bytes line")
      .toEqual([...allExpected, "MARKER:NORMAL_AFTER"]);
    const records = await assertWireProvenance();
    const connections = records.filter((entry: any) => entry.event === "connection");
    expect(connections.map((entry: any) => entry.connection)).toEqual([1, 2, 3]);
    for (const dial of connections.slice(1)) {
      expect(dial.query.since, `dial ${dial.connection} echoes the position the page parsed`).toBe(String(emitted.length));
      expect(dial.query.generation).toBe(String(session.generation));
    }
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
    expect(session.replay_bytes, "a redial from the parsed position replays nothing").toBe(0);
    expect(session.seq, "server cursor accounts for the fixture's exact emitted bytes").toBe(Buffer.from(alternateSource.bytes, "base64").length);
    expect(session.missed_bytes).toBe(0);
    expect(recovery.deliveries.filter((frame) => frame.binary), "the continued view gets no prelude and no mode reassert").toEqual([]);
    const recovered = await snapshot("recovered alternate");
    expect(recovered.active).toBe("alternate");
    expect(recovered.alternate, "the continued view keeps its alternate screen and cursor").toEqual(alternate.alternate);
    await emit("redraw", { name: "RECOVERED" });
    await recovery.bytesInclude("SCREEN:RECOVERED\r\n");
    const redrawn = await snapshot("redrawn alternate");
    expect(redrawn.alternate.rows.filter(Boolean)).toEqual(["SCREEN:RECOVERED"]);
    await emit("alternate", { enabled: false });
    // The core reads only the screen that shows: the normal screen is read
    // once the program leaves the alternate one, which restores the cursor
    // entering saved, and before the prompt moves it.
    await recovery.bytesInclude("\x1b[?1049l");
    const left = await snapshot("normal screen after the alternate one");
    expect(left.active).toBe("normal");
    expect(left.normal, "the alternate screen, the cut and the empty replay preserve every normal row and cursor").toEqual(before.normal);
    await emit("marker", { name: "FINAL_PROMPT" });
    await recovery.bytesInclude("MARKER:FINAL_PROMPT\r\n");
    const final = await snapshot("returned to normal prompt");
    expect(final.active).toBe("normal");
    expect(final.normal.rows.filter(Boolean), "history above the final prompt is intact").toEqual([...expected, "MARKER:FINAL_PROMPT"]);
    const records = await assertWireProvenance();
    const connections = records.filter((entry: any) => entry.event === "connection");
    expect(connections.map((entry: any) => entry.connection)).toEqual([1, 2, 3]);
    for (const dial of connections.slice(1)) {
      expect(dial.query.since, `dial ${dial.connection} echoes the position the page parsed`).toBe(String(session.seq));
      expect(dial.query.generation).toBe(String(session.generation));
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
