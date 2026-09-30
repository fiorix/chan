import { expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalReplay")).parserTerminalModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { bytes as Buffer, caseName, drainParser, emit, mountRealTerminal, observations, parsers, ReplaySocket, requiredSubcases, rpc, save, snapshot } from "../__tests__/terminalReplay";
import { pressInTerminal } from "../__tests__/terminalTab";

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
        await drainParser("after-ready boundary");
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
    const utf8Start = Buffer.from(splitText.slice(0, splitText.indexOf("\u03bb"))).length;
    const escapeStart = Buffer.from(splitText.slice(0, splitText.indexOf("\x1b[31m"))).length;
    const variants = [
      { name: "normal-interior-prefix", boundary: "inside-replay", bytes: 21 },
      { name: "normal-utf8-prefix", boundary: "inside-replay", bytes: utf8Start + 1 },
      { name: "normal-escape-prefix", boundary: "inside-replay", bytes: escapeStart + 2 },
      { name: "normal-before-ready", boundary: "before-ready", bytes: splitBytes.length },
      { name: "normal-repeated-failed-dial", boundary: "inside-replay", bytes: 21 },
    ];
    let current = afterReadyRecovery;
    for (const variant of variants) {
      const first = current.connection + 1;
      const second = first + 1;
      const failedDials = variant.name === "normal-repeated-failed-dial" ? [second + 1, second + 2] : [];
      let ackTail = Promise.resolve();
      let delivered = 0;
      ReplaySocket.acknowledge = (message) => {
        if (message.connection !== first && message.connection !== second) return Promise.resolve();
        ackTail = ackTail.then(async () => {
          if (message.connection === first && message.type === "session") {
            await rpc("ack", { connection: first, frame: message.frame, drained: false });
          } else if (message.connection === second) {
            if (message.binary) delivered += Buffer.from(message.bytes, "base64").length;
            if (message.binary && delivered === variant.bytes) {
              await drainParser(`${variant.name} boundary`);
              await rpc("ack", { connection: second, frame: message.frame, drained: true });
            }
          }
        });
        return ackTail;
      };
      await rpc("arm-sequence", { arms: [
        { boundary: "after-session", ordinal: first },
        { boundary: variant.boundary, ordinal: second, ...(variant.boundary === "inside-replay" ? { bytes: variant.bytes } : {}) },
        ...failedDials.map((ordinal) => ({ boundary: "before-session", ordinal })),
      ] });
      current.disconnect();
      const cuts = await rpc("cuts");
      expect(cuts).toHaveLength(2 + failedDials.length);
      expect(cuts[0].boundary).toBe("after-session");
      expect(cuts[0].replayForwarded).toBe(0);
      expect(cuts[1].boundary).toBe(variant.boundary);
      expect(cuts[1].replayBytes).toBe(splitBytes.length);
      expect(cuts[1].replayForwarded).toBe(variant.bytes);
      expect(cuts[1].lastAcknowledged.drained).toBe(true);
      for (const cut of cuts) expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
      expect((await ReplaySocket.dial(first)).deliveries.map((frame) => frame.type)).toEqual(["session"]);
      const interrupted = await ReplaySocket.dial(second);
      expect(interrupted.deliveries.some((frame) => frame.type === "ready")).toBe(false);
      expect(binaryOf(interrupted).toString("base64"), "the interrupted page receives the exact requested prefix")
        .toBe(Buffer.from(splitBytes.subarray(0, variant.bytes)).toString("base64"));
      if (variant.name === "normal-utf8-prefix") {
        expect(splitBytes[variant.bytes - 1]).toBe(0xce);
        expect(splitBytes[variant.bytes]).toBe(0xbb);
      } else if (variant.name === "normal-escape-prefix") {
        expect(Buffer.from(splitBytes.subarray(variant.bytes - 2, variant.bytes)).toString()).toBe("\x1b[");
        expect(splitBytes[variant.bytes]).toBe(0x33);
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
        .toEqual({ seq: splitBytes.length, replay: splitBytes.length, missed: 0, generation });
      expect(binaryOf(current).toString("base64"), "recovery delivers the full independent fixture log").toBe(splitBytes.toString("base64"));
      const parsed = await snapshot(`${variant.name} recovery`);
      expect(parsed.active).toBe("normal");
      expect(parsed.normal, "a second cut reconstructs each row and the original cursor exactly once").toEqual(splitBaseline.normal);
      records = await assertWireProvenance();
      for (const ordinal of [second, ...failedDials, recoveryOrdinal]) {
        const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === ordinal);
        expect(dial.query.since).toBe("0");
        expect(dial.query.generation).toBeUndefined();
      }
      passed(variant.name, { cuts, session, prefixBytes: variant.bytes, fixtureSha256: splitSource.sha256 });
    }
    passed("normal-second-cut", { variants: variants.map((variant) => variant.name) });

    await emit("alternate", { enabled: true });
    await emit("bytes", { base64: Buffer.from("\x1b[?1h\x1b[?2004h\x1b[>4;2m\x1b[>8u").toString("base64") });
    await emit("redraw", { name: "ATTACH_ALT_BASE" });
    await current.bytesInclude("SCREEN:ATTACH_ALT_BASE\r\n");
    const alternateBaseline = await snapshot("alternate attach baseline");
    expect(alternateBaseline.active).toBe("alternate");
    expect(alternateBaseline.normal).toEqual(splitBaseline.normal);
    const protocol = mounted.tab.keyboardProtocol;
    const protocolValue = JSON.parse(JSON.stringify(protocol));
    let expectedKeys = "";
    const alternatePrelude = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?1h\x1b[?2004h";
    async function alternateKeys(label: string) {
      for (const modifier of [{ ctrlKey: true }, { shiftKey: true }]) {
        expect(pressInTerminal(parsers.at(-1)!, { key: "Enter", code: "Enter", ...modifier }).handled).toBe(false);
      }
      expectedKeys += "\x1b[27;5;13~\x1b[27;2;13~";
      expect(Buffer.from(await rpc("keys", { length: Buffer.from(expectedKeys).length }), "base64").toString(), label).toBe(expectedKeys);
    }
    await alternateKeys("alternate keys before cuts");
    const alternateVariants = [
      { name: "alternate-before-session", boundary: "before-session", failures: 0 },
      { name: "alternate-after-prelude", boundary: "after-replay-frame", frames: 1, failures: 0 },
      { name: "alternate-after-modes", boundary: "after-replay-frame", frames: 2, failures: 0 },
      { name: "alternate-before-ready", boundary: "before-ready", failures: 0 },
      { name: "alternate-after-ready", boundary: "after-ready", failures: 0 },
      { name: "alternate-second-cut", boundary: "after-session", failures: 1 },
      { name: "alternate-repeated-failed-dial", boundary: "after-session", failures: 2 },
    ];
    for (const variant of alternateVariants) {
      const first = current.connection + 1;
      const recoveryOrdinal = first + variant.failures + 1;
      const source = await rpc("fixture-log");
      const seq = Buffer.from(source.bytes, "base64").length;
      let ackTail = Promise.resolve();
      ReplaySocket.acknowledge = (message) => {
        if (message.connection !== first) return Promise.resolve();
        ackTail = ackTail.then(async () => {
          const atBoundary = variant.boundary === "before-ready"
            || (variant.boundary === "after-replay-frame" && message.frame === 1 + variant.frames!)
            || (variant.boundary === "after-ready" && message.type === "ready")
            || (variant.boundary === "after-session" && message.type === "session");
          if (atBoundary) {
            await drainParser(`${variant.name} boundary`);
            await rpc("ack", { connection: first, frame: message.frame, drained: true });
          }
        });
        return ackTail;
      };
      await rpc("arm-sequence", { arms: [{ boundary: variant.boundary, ordinal: first, frames: variant.frames },
        ...Array.from({ length: variant.failures }, (_, index) => ({ boundary: "before-session", ordinal: first + index + 1 }))] });
      current.disconnect();
      const cuts = await rpc("cuts");
      expect(cuts).toHaveLength(variant.failures + 1);
      for (const cut of cuts) {
        expect(cut.replayBytes, "alternate prelude and modes are excluded from ring replay").toBe(0);
        expect(cut.replayForwarded).toBe(0);
        expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
        if (cut.boundary === "before-session") expect((await ReplaySocket.dial(cut.connection)).deliveries).toEqual([]);
      }
      const interrupted = await ReplaySocket.dial(first);
      if (variant.boundary === "after-replay-frame") {
        const expected = variant.frames === 1 ? "\x1b[?1049h\x1b[2J\x1b[H" : alternatePrelude;
        expect(binaryOf(interrupted).toString(), "the counted cut delivers exactly the selected prelude or mode prefix").toBe(expected);
        expect(interrupted.deliveries.map((frame) => frame.type)).toEqual(["session", ...Array(variant.frames).fill(null)]);
        expect(cuts[0].upstreamFrame, "the cut is at the counted frame, before ready").toBe(1 + variant.frames!);
        expect(cuts[0].lastAcknowledged).toEqual({ frame: 1 + variant.frames!, drained: true });
      }
      if (variant.boundary === "before-ready" || variant.boundary === "after-ready") {
        expect(binaryOf(interrupted).toString(), "alternate prelude precedes the negotiated private-mode reassert").toBe(alternatePrelude);
        expect(cuts[0].lastAcknowledged.drained).toBe(true);
        expect(interrupted.deliveries.some((frame) => frame.type === "ready")).toBe(variant.boundary === "after-ready");
      }
      current = await ReplaySocket.dial(recoveryOrdinal);
      await current.ready();
      const session = sessionOf(current);
      expect({ seq: session.seq, replay: session.replay_bytes, missed: session.missed_bytes, generation: session.generation })
        .toEqual({ seq, replay: 0, missed: 0, generation });
      expect(binaryOf(current).toString()).toBe(alternatePrelude);
      const parsed = await snapshot(`${variant.name} recovery`);
      expect(parsed.active).toBe("alternate");
      expect(parsed.normal, "empty replay and prelude preserve the normal history and cursor").toEqual(splitBaseline.normal);
      expect(mounted.tab.keyboardProtocol).toBe(protocol);
      expect(JSON.parse(JSON.stringify(mounted.tab.keyboardProtocol))).toEqual(protocolValue);
      expect(parsers.at(-1)!.model.modes.applicationCursorKeysMode).toBe(true);
      expect(parsers.at(-1)!.model.modes.bracketedPasteMode).toBe(true);
      await alternateKeys(`${variant.name} keys`);
      records = await assertWireProvenance();
      const dials = records.filter((entry: any) => entry.event === "connection" && entry.connection >= first && entry.connection <= recoveryOrdinal);
      expect(dials).toHaveLength(variant.failures + 2);
      for (const dial of dials) {
        const cutReplay = dial.connection !== first && ["before-ready", "after-session", "after-replay-frame"].includes(variant.boundary);
        expect(dial.query.since).toBe(cutReplay ? "0" : String(seq));
        expect(dial.query.generation).toBe(cutReplay ? undefined : String(generation));
      }
      await emit("redraw", { name: variant.name });
      await current.bytesInclude(`SCREEN:${variant.name}\r\n`);
      const redrawn = await snapshot(`${variant.name} redraw`);
      expect(redrawn.alternate.rows.filter(Boolean)).toEqual([`SCREEN:${variant.name}`]);
      expect(redrawn.normal).toEqual(splitBaseline.normal);
      passed(variant.name, { cuts, session, protocol: protocolValue });
    }
    await emit("alternate", { enabled: false });
    await emit("bytes", { base64: Buffer.from("\x1b[?1l\x1b[?2004l").toString("base64") });
    await emit("marker", { name: "ATTACH_NORMAL_RETURN" });
    await current.bytesInclude("MARKER:ATTACH_NORMAL_RETURN\r\n");
    const returned = await snapshot("normal prompt after all alternate cuts");
    expect(returned.active).toBe("normal");
    expect(returned.normal.rows.filter(Boolean)).toEqual([...splitRows, "MARKER:ATTACH_NORMAL_RETURN"]);
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

if (caseName === "overflow") test("an overflow replay retains one exact loss notice and removes evicted history", async () => {
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
    // Carriage returns fill the byte ring without exhausting the parser's row history.
    for (let index = 0; index < 12; index++) {
      await emit("bytes", { base64: Buffer.from("\r".repeat(262144)).toString("base64") });
    }
    await emit("rows", { prefix: "SURVIVES", count: 64 });
    await emit("marker", { name: "OVERFLOW_END" });
    await mounted.socket.bytesInclude("MARKER:OVERFLOW_END\r\n");
    const before = await snapshot("overflow before cut");
    expect(before.normal.rows.filter(Boolean).slice(0, 9), "evicted rows are still in the page before recovery").toEqual(old.normal.rows.filter(Boolean));
    const source = await rpc("fixture-log");
    const emitted = Buffer.from(source.bytes, "base64");
    ReplaySocket.acknowledge = async (message) => {
      if (message.connection === 2 && message.type === "session") {
        await rpc("ack", { connection: 2, frame: message.frame, drained: false });
      }
    };
    await rpc("arm", { boundary: "after-session", ordinal: 2 });
    mounted.socket.disconnect();
    const cut = await rpc("cut");
    expect(cut.disconnect).toEqual({ client: "closed", upstream: "closed" });
    expect(cut.replayForwarded).toBe(0);
    expect((await ReplaySocket.dial(2)).deliveries.map((frame) => frame.type)).toEqual(["session"]);
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
    expect(recovered.normal.rows.filter(Boolean), "one correctly counted notice survives above every retained row").toEqual([notice, ...rows]);
    expect(recovered.normal.rows.some((row) => row.includes("EVICTED") || row.includes("OLD_PROMPT")), "old markers do not survive the reset").toBe(false);
    await emit("marker", { name: "OVERFLOW_LIVE" });
    await recovery.bytesInclude("MARKER:OVERFLOW_LIVE\r\n");
    const final = await snapshot("overflow live suffix");
    expect(final.normal.rows.filter(Boolean)).toEqual([notice, ...rows, "MARKER:OVERFLOW_LIVE"]);
    const records = await assertWireProvenance();
    const dial = records.find((entry: any) => entry.event === "connection" && entry.connection === 3);
    expect(dial.query.since).toBe("0");
    expect(dial.query.generation).toBeUndefined();
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
