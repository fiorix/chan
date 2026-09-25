import { describe, expect, test } from "vitest";
import terminalTab from "./TerminalTab.svelte?raw";

// "Copy path to $CWD" runs from the command launcher, whose overlay is
// dismissing when the chan:command fires. A bare navigator.clipboard.writeText()
// then rejects ("Document is not focused") and the caller's `void` swallows the
// rejection, so nothing lands on the clipboard. copyTerminalCwd must put focus
// back on the terminal before writing, and write through the desktop-native
// writeClipboardText, which needs no gesture on WKWebView.

describe("terminal copy-cwd clipboard write", () => {
  test("focuses the terminal before the clipboard write", () => {
    expect(terminalTab).toMatch(
      /async function copyTerminalCwd[\s\S]*?focusTerminal\(\);[\s\S]*?await writeClipboardText\(cwd\)/,
    );
  });

  test("writes through the desktop-safe writeClipboardText", () => {
    expect(terminalTab).toMatch(
      /async function copyTerminalCwd[\s\S]*?await writeClipboardText\(cwd\)/,
    );
    expect(terminalTab).toMatch(
      /import \{[\s\S]*?writeClipboardText[\s\S]*?\} from "\.\.\/api\/desktop"/,
    );
  });

  test("copies the absolute cwd, preferring terminalCwdAbs", () => {
    expect(terminalTab).toMatch(
      /function terminalCwdForCopy\(\)[\s\S]*?if \(terminalCwdAbs\) return terminalCwdAbs;/,
    );
    expect(terminalTab).toMatch(/const cwd = terminalCwdForCopy\(\);/);
  });
});
