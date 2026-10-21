import { describe, expect, test } from "vitest";
import {
  PtyWriteTracker,
  isReplayGeneratedTerminalInput,
  isTerminalGeneratedReply,
  routeXtermData,
  shouldForwardGeneratedTerminalInput,
  terminalMessageBytes,
} from "./connection";

describe("terminal connection invariants", () => {
  test("tracks pending PTY writes until xterm drains them", () => {
    const tracker = new PtyWriteTracker();
    let drain: (() => void) | undefined;

    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([1, 2, 3]),
    );

    expect(tracker.active).toBe(true);
    drain?.();
    expect(tracker.active).toBe(false);
  });

  test("clears pending PTY writes when xterm write throws", () => {
    const tracker = new PtyWriteTracker();
    expect(() =>
      tracker.write(
        {
          write() {
            throw new Error("boom");
          },
        },
        new Uint8Array([1]),
      ),
    ).toThrow("boom");
    expect(tracker.active).toBe(false);
  });

  test("reports each completed write origin exactly once", () => {
    const tracker = new PtyWriteTracker();
    const completed: string[] = [];
    let drain: (() => void) | undefined;
    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([1]),
      "replay",
      (origin) => completed.push(origin),
    );

    drain?.();
    drain?.();
    expect(completed).toEqual(["replay"]);
  });

  test("decodes websocket binary payloads without string coercion", async () => {
    const bytes = await terminalMessageBytes(new Uint8Array([0, 159, 146, 169]).buffer);
    expect(Array.from(bytes ?? [])).toEqual([0, 159, 146, 169]);

    const blob = new Blob([new Uint8Array([0xff, 0x00])]);
    expect(Array.from((await terminalMessageBytes(blob)) ?? [])).toEqual([0xff, 0x00]);
    expect(await terminalMessageBytes(JSON.stringify({ type: "ready" }))).toBeNull();
  });

  test("routes xterm-generated replies to the owning PTY only", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];
    let drain: (() => void) | undefined;

    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([27, 91, 54, 110]),
    );

    routeXtermData("\x1b[1;1R", tracker, (data) => direct.push(data), (data) => user.push(data));
    drain?.();
    routeXtermData("a", tracker, (data) => direct.push(data), (data) => user.push(data));

    expect(direct).toEqual(["\x1b[1;1R"]);
    expect(user).toEqual(["a"]);
  });

  test("routes idle xterm focus reports to the owning PTY", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];

    for (const report of ["\x1b[I", "\x1b[O"]) {
      routeXtermData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
    }

    expect(tracker.currentOrigin).toBeNull();
    expect(direct).toEqual(["\x1b[I", "\x1b[O"]);
    expect(user).toEqual([]);
  });

  test("broadcasts typed input without a pending write", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];

    for (const typed of ["typed", "\x1b[Ityped"]) {
      routeXtermData(typed, tracker, (data) => direct.push(data), (data) => user.push(data));
    }

    expect(direct).toEqual([]);
    expect(user).toEqual(["typed", "\x1b[Ityped"]);
  });

  test("routes xterm focus reports to the owning PTY during a live write", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];
    let drain: (() => void) | undefined;
    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([27, 91, 63, 49, 48, 48, 52, 104]),
    );

    expect(tracker.currentOrigin).toBe("live");
    for (const report of ["\x1b[I", "\x1b[O"]) {
      routeXtermData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
    }
    drain?.();

    expect(direct).toEqual(["\x1b[I", "\x1b[O"]);
    expect(user).toEqual([]);
    expect(tracker.currentOrigin).toBeNull();
  });

  test("drops xterm focus reports generated during a replay write", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];
    let drain: (() => void) | undefined;
    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([27, 91, 63, 49, 48, 48, 52, 104]),
      "replay",
    );

    expect(tracker.currentOrigin).toBe("replay");
    for (const report of ["\x1b[I", "\x1b[O"]) {
      routeXtermData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
    }
    drain?.();

    expect(direct).toEqual([]);
    expect(user).toEqual([]);
    expect(tracker.currentOrigin).toBeNull();
  });

  test("suppresses terminal-generated replies from duplicate replay writes", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];
    let drain: (() => void) | undefined;

    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([27, 91, 54, 110]),
      "replay",
    );

    routeXtermData("\x1b[1;1R", tracker, (data) => direct.push(data), (data) => user.push(data));
    routeXtermData("typed", tracker, (data) => direct.push(data), (data) => user.push(data));
    expect(shouldForwardGeneratedTerminalInput(tracker)).toBe(false);
    drain?.();

    expect(direct).toEqual([]);
    expect(user).toEqual(["typed"]);
    expect(shouldForwardGeneratedTerminalInput(tracker)).toBe(true);
  });

  test("forwards a bracketed paste while a replay write is draining", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];
    let drain: (() => void) | undefined;
    const paste = "\x1b[200~pasted text\x1b[201~";

    tracker.write(
      {
        write(_bytes, callback) {
          drain = callback;
        },
      },
      new Uint8Array([27, 91, 54, 110]),
      "replay",
    );

    routeXtermData(paste, tracker, (data) => direct.push(data), (data) => user.push(data));
    drain?.();

    expect(direct).toEqual([]);
    expect(user).toEqual([paste]);
  });

  test("recognizes common terminal-generated report replies", () => {
    expect(isTerminalGeneratedReply("\x1b[1;2R")).toBe(true);
    expect(isTerminalGeneratedReply("\x1b[?1;2c\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalGeneratedReply("\x1bP1$r0;4;2m\x1b\\")).toBe(true);
    expect(isTerminalGeneratedReply("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")).toBe(true);
    expect(isTerminalGeneratedReply("a")).toBe(false);
    expect(isTerminalGeneratedReply("\x1b[A")).toBe(false);
  });

  test("treats escape-prefixed replay input as generated even when unknown", () => {
    expect(isReplayGeneratedTerminalInput("\x1b[A")).toBe(true);
    expect(isReplayGeneratedTerminalInput("a")).toBe(false);
  });

  test("lets a lone ESC through: it is a keystroke, not a reply", () => {
    // Escape, and Ctrl+[ which encodes to the same byte, are the user's. The
    // fail-closed rule above is about replies replay can re-trigger, and a
    // reply is never one character: it carries an introducer and a terminator
    // after the ESC. Dropping this one loses a key the user pressed while a
    // reattach is still replaying.
    expect(isReplayGeneratedTerminalInput("\x1b")).toBe(false);
    // The shapes it must keep catching are all longer than one byte.
    expect(isReplayGeneratedTerminalInput("\x1b[")).toBe(true);
    expect(isReplayGeneratedTerminalInput("\x1bP")).toBe(true);
  });
});

describe("data the user made, marked by xterm.js", () => {
  /// A tracker holding one undrained write of `origin`, and the two senders.
  function pending(origin: "live" | "replay") {
    const tracker = new PtyWriteTracker();
    let drain: (() => void) | undefined;
    tracker.write({ write: (_bytes, callback) => void (drain = callback) }, new Uint8Array([65]), origin);
    const direct: string[] = [];
    const group: string[] = [];
    const route = (data: string, user: boolean) =>
      routeXtermData(data, tracker, (d) => direct.push(d), (d) => group.push(d), user);
    return { tracker, direct, group, route, drain: () => drain?.() };
  }

  test("a key typed while a live write is pending reaches the group, a reply the own PTY", () => {
    const { tracker, direct, group, route } = pending("live");
    expect(tracker.currentOrigin).toBe("live");
    route("k", true);
    route("\x1b[1;1R", false);
    expect(group).toEqual(["k"]);
    expect(direct).toEqual(["\x1b[1;1R"]);
  });

  test("an escape-encoded key typed during a live write is routed as a key", () => {
    const { direct, group, route } = pending("live");
    // A modified arrow, and the kitty protocol's `u` final a reply can also end in.
    route("\x1b[1;5A", true);
    route("\x1b[97;5u", true);
    expect(group).toEqual(["\x1b[1;5A", "\x1b[97;5u"]);
    expect(direct).toEqual([]);
  });

  test("a lone focus report keeps its own PTY even when marked", () => {
    const idle = new PtyWriteTracker();
    const direct: string[] = [];
    const group: string[] = [];
    routeXtermData("\x1b[I", idle, (d) => direct.push(d), (d) => group.push(d), true);
    const live = pending("live");
    live.route("\x1b[O", true);
    expect(direct).toEqual(["\x1b[I"]);
    expect(live.direct).toEqual(["\x1b[O"]);
    expect([...group, ...live.group]).toEqual([]);
  });

  test("a key typed during a replay write reaches the group, a reply is dropped", () => {
    const { tracker, direct, group, route } = pending("replay");
    expect(tracker.currentOrigin).toBe("replay");
    route("\x1b[A", true);
    route("\x1b[1;1R", false);
    expect(group).toEqual(["\x1b[A"]);
    expect(direct).toEqual([]);
  });
});
