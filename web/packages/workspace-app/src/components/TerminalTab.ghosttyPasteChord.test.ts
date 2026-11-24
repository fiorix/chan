// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  handleTerminalClipboardChord,
  terminalClipboardKeyHandlerResult,
} from "../terminal/clipboardChord";

type GhosttyChordResult = {
  event: KeyboardEvent;
  ghosttyClaimed: boolean;
  copySelection: ReturnType<typeof vi.fn>;
};

function dispatchGhosttyClipboardChord(
  init: KeyboardEventInit,
  os: string,
): GhosttyChordResult {
  const target = document.createElement("div");
  const copySelection = vi.fn();
  let ghosttyClaimed = false;
  target.addEventListener("keydown", (event) => {
    const matched = handleTerminalClipboardChord(event, { os, copySelection });
    if (!matched) return;

    const chanResult = terminalClipboardKeyHandlerResult(
      event,
      os,
      "ghostty",
    );
    // This is the widget's custom-key-handler contract: true claims the
    // key, which the widget then neither sends nor default-prevents.
    // TerminalTab passes the inverse of chanResult to that handler.
    ghosttyClaimed = !chanResult;
  });

  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return { event, ghosttyClaimed, copySelection };
}

describe("Ghostty terminal paste chord", () => {
  test.each([
    ["macOS Cmd+V", "mac", { key: "v", code: "KeyV", metaKey: true }],
    [
      "Linux/Windows Ctrl+Shift+V",
      "linux",
      { key: "v", code: "KeyV", ctrlKey: true, shiftKey: true },
    ],
  ])("%s does not suppress the native paste", (_name, os, init) => {
    const { event, ghosttyClaimed, copySelection } =
      dispatchGhosttyClipboardChord(init, os);

    expect(ghosttyClaimed).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
  });

  test("copy is claimed from Ghostty, and chan cancels the key itself", () => {
    const { event, ghosttyClaimed, copySelection } =
      dispatchGhosttyClipboardChord(
        { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true },
        "linux",
      );

    expect(ghosttyClaimed).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(copySelection).toHaveBeenCalledOnce();
  });
});
