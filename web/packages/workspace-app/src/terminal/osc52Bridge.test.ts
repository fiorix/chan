import { beforeEach, describe, expect, test, vi } from "vitest";
import { Osc52Bridge } from "./osc52Bridge";
import { writeClipboardText } from "../api/desktop";

vi.mock("../api/desktop", () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

describe("Osc52Bridge", () => {
  const writeMock = vi.mocked(writeClipboardText);

  beforeEach(() => {
    writeMock.mockClear();
  });

  test("decodes a BEL-terminated copy payload", () => {
    new Osc52Bridge().push(bytes(`\x1b]52;c;${btoa("hello")}\x07`));
    expect(writeMock).toHaveBeenCalledWith("hello");
  });

  test("decodes an ST-terminated copy payload", () => {
    new Osc52Bridge().push(bytes(`\x1b]52;c;${btoa("hello")}\x1b\\`));
    expect(writeMock).toHaveBeenCalledWith("hello");
  });

  test("decodes multibyte UTF-8 via TextDecoder, not raw atob", () => {
    const text = "héllo → 世界";
    const payload = btoa(String.fromCharCode(...enc.encode(text)));
    new Osc52Bridge().push(bytes(`\x1b]52;c;${payload}\x07`));
    expect(writeMock).toHaveBeenCalledWith(text);
  });

  test("assembles a candidate split across chunk boundaries", () => {
    const bridge = new Osc52Bridge();
    const full = `\x1b]52;c;${btoa("chunked")}\x07`;
    // Split inside the prefix, inside the payload, and before the BEL.
    const cuts = [2, 6, full.length - 1];
    let off = 0;
    for (const cut of cuts) {
      bridge.push(bytes(full.slice(off, cut)));
      off = cut;
    }
    bridge.push(bytes(full.slice(off)));
    expect(writeMock).toHaveBeenCalledWith("chunked");
  });

  test("handles multiple sequences in one chunk, with prose between", () => {
    new Osc52Bridge().push(
      bytes(
        `prompt$ \x1b]52;c;${btoa("one")}\x07more output\x1b]52;s;${btoa("two")}\x1b\\trail`,
      ),
    );
    expect(writeMock).toHaveBeenNthCalledWith(1, "one");
    expect(writeMock).toHaveBeenNthCalledWith(2, "two");
  });

  test("consumes the read/query form without answering or writing", () => {
    new Osc52Bridge().push(bytes("\x1b]52;c;?\x07"));
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("ignores other OSC sequences (title, hyperlink)", () => {
    new Osc52Bridge().push(
      bytes("\x1b]0;my title\x07\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"),
    );
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("ignores an OSC 52-looking prefix that is not 52", () => {
    new Osc52Bridge().push(bytes(`\x1b]5;${btoa("nope")}\x07\x1b]520;${btoa("nope")}\x07`));
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("drops a candidate aborted by a C0 control or a non-ST ESC", () => {
    const bridge = new Osc52Bridge();
    bridge.push(bytes(`\x1b]52;c;${btoa("nope")}\x18rest`));
    bridge.push(bytes(`\x1b]52;c;${btoa("nope")}\x1b[31m`));
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("warns and skips malformed base64 without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Osc52Bridge().push(bytes("\x1b]52;c;!!!not-base64!!!\x07"));
    expect(writeMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("drops an over-cap candidate but keeps scanning after it", () => {
    const bridge = new Osc52Bridge();
    // 1MB+ of payload pushed in one chunk: candidate exceeds MAX_HOLD.
    bridge.push(bytes(`\x1b]52;c;${"A".repeat((1 << 20) + 16)}`));
    expect(writeMock).not.toHaveBeenCalled();
    // The scanner recovered: a following sequence still lands.
    bridge.push(bytes(`\x1b]52;c;${btoa("after")}\x07`));
    expect(writeMock).toHaveBeenCalledWith("after");
  });

  test("reset() drops a held partial candidate", () => {
    const bridge = new Osc52Bridge();
    bridge.push(bytes("\x1b]52;c;"));
    bridge.reset();
    bridge.push(bytes(`${btoa("nope")}\x07`));
    expect(writeMock).not.toHaveBeenCalled();
  });

  test("chunks without ESC are ignored cheaply", () => {
    new Osc52Bridge().push(bytes("plain program output, no escapes\n"));
    expect(writeMock).not.toHaveBeenCalled();
  });
});
