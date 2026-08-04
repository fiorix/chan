// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  handleTerminalClipboardChord,
  terminalClipboardKeyHandlerResult,
} from "../terminal/clipboardChord";
import terminalTab from "./TerminalTab.svelte?raw";

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
    // This is ghostty-web's custom-key-handler contract: true claims the
    // key and calls preventDefault before returning. TerminalTab passes the
    // inverse of chanResult to that handler.
    ghosttyClaimed = !chanResult;
    if (ghosttyClaimed) event.preventDefault();
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

  test("copy keeps Ghostty's existing claimed-key routing", () => {
    const { event, ghosttyClaimed, copySelection } =
      dispatchGhosttyClipboardChord(
        { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true },
        "linux",
      );

    expect(ghosttyClaimed).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(copySelection).toHaveBeenCalledOnce();
  });

  test("TerminalTab applies the backend-aware result before its pinned inversion", () => {
    expect(terminalTab).toMatch(
      /return terminalClipboardKeyHandlerResult\(e, currentOS\(\), backend\);/,
    );
    expect(terminalTab).toMatch(
      /term\.attachCustomKeyEventHandler\(\(e\) => !handleTerminalKeyEvent\(e\)\);/,
    );
  });
});
