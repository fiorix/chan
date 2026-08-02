// @vitest-environment jsdom

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { expect, test } from "vitest";
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
