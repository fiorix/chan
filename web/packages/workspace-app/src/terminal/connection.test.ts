import { describe, expect, test } from "vitest";
import {
  PtyWriteTracker,
  routeTerminalData,
  shouldForwardGeneratedTerminalInput,
  terminalMessageBytes,
  terminalMouseReport,
} from "./connection";

describe("terminal connection invariants", () => {
  test("classifies complete mouse reports without mistaking typed escape data for one", () => {
    expect(terminalMouseReport("\x1b[M !!")).toBe("x10");
    expect(terminalMouseReport("\x1b[<0;10;5M")).toBe("sgr");
    expect(terminalMouseReport("\x1b[<0;10;5m")).toBe("sgr");
    expect(terminalMouseReport("\x1b[Mx")).toBeNull();
    expect(terminalMouseReport("\x1b[<0;10;5Mtyped")).toBeNull();
  });
  test("tracks pending PTY writes until the terminal drains them", () => {
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

  test("clears pending PTY writes when the terminal's write throws", () => {
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

  test("routes terminal-generated replies to the owning PTY only", () => {
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

    routeTerminalData("\x1b[1;1R", tracker, (data) => direct.push(data), (data) => user.push(data));
    drain?.();
    routeTerminalData("a", tracker, (data) => direct.push(data), (data) => user.push(data));

    expect(direct).toEqual(["\x1b[1;1R"]);
    expect(user).toEqual(["a"]);
  });

  test("routes idle focus reports to the owning PTY", () => {
    const tracker = new PtyWriteTracker();
    const direct: string[] = [];
    const user: string[] = [];

    for (const report of ["\x1b[I", "\x1b[O"]) {
      routeTerminalData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
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
      routeTerminalData(typed, tracker, (data) => direct.push(data), (data) => user.push(data));
    }

    expect(direct).toEqual([]);
    expect(user).toEqual(["typed", "\x1b[Ityped"]);
  });

  test("routes focus reports to the owning PTY during a live write", () => {
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
      routeTerminalData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
    }
    drain?.();

    expect(direct).toEqual(["\x1b[I", "\x1b[O"]);
    expect(user).toEqual([]);
    expect(tracker.currentOrigin).toBeNull();
  });

  test("drops focus reports generated during a replay write", () => {
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
      routeTerminalData(report, tracker, (data) => direct.push(data), (data) => user.push(data));
    }
    drain?.();

    expect(direct).toEqual([]);
    expect(user).toEqual([]);
    expect(tracker.currentOrigin).toBeNull();
  });

  test("drops escape-prefixed chunks handed over inside a replay write, replies and unknown shapes alike", () => {
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

    routeTerminalData("\x1b[1;1R", tracker, (data) => direct.push(data), (data) => user.push(data));
    routeTerminalData("\x1b[A", tracker, (data) => direct.push(data), (data) => user.push(data));
    routeTerminalData("typed", tracker, (data) => direct.push(data), (data) => user.push(data));
    expect(shouldForwardGeneratedTerminalInput(tracker)).toBe(false);
    drain?.();

    expect(direct).toEqual([]);
    expect(user).toEqual(["typed"]);
    expect(shouldForwardGeneratedTerminalInput(tracker)).toBe(true);
  });
});
