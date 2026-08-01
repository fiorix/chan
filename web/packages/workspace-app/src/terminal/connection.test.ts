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
});
