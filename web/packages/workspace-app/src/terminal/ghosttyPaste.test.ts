// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import {
  handleGhosttyControlV,
  handleGhosttyEmptyPaste,
  isBareControlV,
  type GhosttyPasteTerminal,
} from "./ghosttyPaste";

function keyEvent(init: KeyboardEventInit & { type?: string }): KeyboardEvent {
  const { type = "keydown", ...rest } = init;
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, ...rest });
}

/// A paste event as the browser delivers it, with the clipboard's plain text
/// stood in: jsdom builds no ClipboardEvent or DataTransfer of its own.
function pasteEvent(text: string | null): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: text === null ? null : { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return event;
}

function terminal(bracketed: boolean): GhosttyPasteTerminal & { pastes: string[] } {
  const pastes: string[] = [];
  return {
    pastes,
    hasBracketedPaste: () => bracketed,
    paste: (text: string) => void pastes.push(text),
  };
}

describe("ghostty Ctrl+V", () => {
  test("a bare Ctrl+V is the control byte on every OS, claimed before ghostty-web drops it", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "v", code: "KeyV", ctrlKey: true });

    expect(isBareControlV(ev)).toBe(true);
    expect(handleGhosttyControlV(ev, sendInput)).toBe(false);
    expect(sendInput).toHaveBeenCalledWith("\x16");
    expect(ev.defaultPrevented).toBe(true);
  });

  test.each([
    ["macOS Cmd+V, chan's paste chord", { key: "v", code: "KeyV", metaKey: true }],
    ["Ctrl+Shift+V, the paste chord elsewhere", { key: "v", code: "KeyV", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Alt+V", { key: "v", code: "KeyV", ctrlKey: true, altKey: true }],
    ["Ctrl+C", { key: "c", code: "KeyC", ctrlKey: true }],
    ["a keyup of Ctrl+V", { type: "keyup", key: "v", code: "KeyV", ctrlKey: true }],
  ])("%s flows on untouched", (_name, init) => {
    const sendInput = vi.fn();
    const ev = keyEvent(init);

    expect(handleGhosttyControlV(ev, sendInput)).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("ghostty empty paste", () => {
  test("a paste with no text reaches the program as an empty bracketed paste", () => {
    const term = terminal(true);
    const ev = pasteEvent("");
    const stopped = vi.spyOn(ev, "stopPropagation");

    expect(handleGhosttyEmptyPaste(ev, term)).toBe(true);
    expect(term.pastes).toEqual([""]);
    expect(ev.defaultPrevented).toBe(true);
    expect(stopped).toHaveBeenCalled();
  });

  test("without bracketed paste an empty paste sends nothing and is still taken from ghostty-web", () => {
    const term = terminal(false);
    const ev = pasteEvent("");

    expect(handleGhosttyEmptyPaste(ev, term)).toBe(true);
    expect(term.pastes).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("a paste that carries text is ghostty-web's", () => {
    const term = terminal(true);
    const ev = pasteEvent("hello");

    expect(handleGhosttyEmptyPaste(ev, term)).toBe(false);
    expect(term.pastes).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("a paste with no clipboard data and a terminal not yet open are left alone", () => {
    expect(handleGhosttyEmptyPaste(pasteEvent(null), terminal(true))).toBe(false);
    const ev = pasteEvent("");
    expect(handleGhosttyEmptyPaste(ev, null)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
  });
});
