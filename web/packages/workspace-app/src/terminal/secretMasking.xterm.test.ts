// @vitest-environment jsdom

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
import { TerminalSecretMasker } from "./secretMasking";

test("real xterm masks wrapped ANSI assignments across buffer switches", async () => {
  // xterm initializes its color parser through a scratch canvas at import
  // time. The matcher test needs no renderer, so this minimal color stub is
  // sufficient and keeps the probe on xterm's real buffer/decoration APIs.
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await import("@xterm/xterm");
  const term = new Terminal({
    allowProposedApi: true,
    cols: 12,
    rows: 2,
  });
  const masker = new TerminalSecretMasker(
    term as XtermTerminal,
    ["TOKEN"],
    "#6c6c70",
    true,
  );
  const snapshot = masker.captureWrite();

  await new Promise<void>((resolve) => {
    term.write(
      new TextEncoder().encode("\x1b[31mNAME_TOKEN=abcdef\x1b[0m"),
      () => {
        masker.scanWrite(snapshot);
        resolve();
      },
    );
  });

  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
    "NAME_TOKEN=a",
  );
  expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("bcdef");
  expect(masker.maskCount).toBe(2);
  masker.setEnabled(false);
  expect(masker.maskCount).toBe(0);
  masker.setEnabled(true);
  expect(masker.maskCount).toBe(2);

  const enterAlternate = masker.captureWrite();
  await new Promise<void>((resolve) => {
    term.write("\x1b[?1049h\x1b[HALT_TOKEN=x", () => {
      masker.scanWrite(enterAlternate);
      resolve();
    });
  });
  expect(term.buffer.active.type).toBe("alternate");
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
    "ALT_TOKEN=x",
  );
  expect(masker.maskCount).toBe(1);

  const leaveAlternate = masker.captureWrite();
  await new Promise<void>((resolve) => {
    term.write("\x1b[?1049l", () => {
      masker.scanWrite(leaveAlternate);
      resolve();
    });
  });
  expect(term.buffer.active.type).toBe("normal");
  expect(masker.maskCount).toBe(2);

  masker.dispose();
  term.dispose();
});

test("real xterm reflows a departed wrapped group before viewport masks are rebuilt", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await import("@xterm/xterm");
  const term = new Terminal({ allowProposedApi: true, cols: 12, rows: 5 });
  const decorations = vi.spyOn(term, "registerDecoration");
  const masker = new TerminalSecretMasker(term as XtermTerminal, ["TOKEN"], "#6c6c70", true);
  try {
    const snapshot = masker.captureWrite();
    await new Promise<void>((resolve) => {
      term.write("NAME_TOKEN=abcdef\r\nnext", () => {
        masker.scanWrite(snapshot);
        resolve();
      });
    });
    const lines = () => [0, 1, 2].map((row) => {
      const line = term.buffer.active.getLine(row)!;
      return { text: line.translateToString(true), wrapped: line.isWrapped };
    });
    expect(term.options.reflowCursorLine, "use the application's default reflow policy").toBe(false);
    expect(term.buffer.active.cursorY, "cursor has left the wrapped group").toBe(2);
    expect(lines()).toEqual([
      { text: "NAME_TOKEN=a", wrapped: false },
      { text: "bcdef", wrapped: true },
      { text: "next", wrapped: false },
    ]);
    expect(masker.maskCount).toBe(2);
    decorations.mockClear();
    term.resize(20, 5);
    expect(lines(), "the buffer really reflowed before scanning").toEqual([
      { text: "NAME_TOKEN=abcdef", wrapped: false },
      { text: "next", wrapped: false },
      { text: "", wrapped: false },
    ]);
    masker.scanViewport();
    expect(decorations.mock.calls.map(([options]) => ({
      row: options.marker.line, x: options.x, width: options.width,
    })), "viewport rescan creates the mask at its reflowed coordinates").toEqual([
      { row: 0, x: 11, width: 6 },
    ]);
    expect(masker.maskCount, "one decoration covers the reflowed value").toBe(1);
  } finally {
    masker.dispose();
    term.dispose();
    decorations.mockRestore();
  }
});
