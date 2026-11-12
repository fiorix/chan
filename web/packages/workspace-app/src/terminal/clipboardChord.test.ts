// @vitest-environment jsdom
//
// The chord a user assigns to the terminal's Copy, as the terminal's chord
// module recognises its keydown: by the lookup the window's key handler runs
// an assigned chord's command with. The built-in copy chord is the
// terminal's own key and is never an assigned one.

import { afterEach, describe, expect, test } from "vitest";

import { allCommands } from "../state/commands";
import "../state/commands/install";
import { assignOverride, hydrateOverrides } from "../state/keymapOverrides.svelte";
import { isAssignedTerminalCopyChord, isTerminalCopyChord } from "./clipboardChord";

const COPY = "terminal.copy";
// jsdom is a browser off the Mac: the web slot, and Mod is Ctrl.
const ASSIGNED = { key: "j", code: "KeyJ", ctrlKey: true, altKey: true } as const;
const BUILT_IN = { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true } as const;

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function assigned(event: Event | undefined): boolean {
  return isAssignedTerminalCopyChord(event, allCommands());
}

afterEach(() => {
  hydrateOverrides(null);
});

describe("the chord assigned to the terminal's Copy", () => {
  test("is its keydown, and no other key's", () => {
    assignOverride(COPY, "Ctrl+Alt+J", "web");

    expect(assigned(keydown(ASSIGNED))).toBe(true);
    expect(assigned(keydown({ ...ASSIGNED, key: "k", code: "KeyK" }))).toBe(false);
    expect(assigned(keydown({ ...ASSIGNED, altKey: false }))).toBe(false);
    expect(assigned(keydown({ key: "Enter", code: "Enter" })), "the launcher's Enter").toBe(false);
  });

  test("is not a key going up, a pointer's click, or no event at all", () => {
    assignOverride(COPY, "Ctrl+Alt+J", "web");

    expect(assigned(new KeyboardEvent("keyup", ASSIGNED))).toBe(false);
    expect(assigned(new MouseEvent("click", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(assigned(undefined)).toBe(false);
  });

  test("is nothing while no chord is assigned, and not a chord assigned to another command", () => {
    expect(assigned(keydown(ASSIGNED))).toBe(false);

    assignOverride("terminal.paste", "Ctrl+Alt+J", "web");
    expect(assigned(keydown(ASSIGNED))).toBe(false);
  });

  test("is the slot of this client alone", () => {
    assignOverride(COPY, "Ctrl+Alt+J", "macos");

    expect(assigned(keydown(ASSIGNED))).toBe(false);
  });

  test("leaves the built-in copy chord the terminal's own, even assigned again as itself", () => {
    expect(isTerminalCopyChord(keydown(BUILT_IN), "linux")).toBe(true);
    expect(assigned(keydown(BUILT_IN))).toBe(false);

    assignOverride(COPY, "Mod+Shift+C", "web");
    expect(assigned(keydown(BUILT_IN))).toBe(false);

    // With another chord assigned the built-in one still matches as built in.
    assignOverride(COPY, "Ctrl+Alt+J", "web");
    expect(isTerminalCopyChord(keydown(BUILT_IN), "linux")).toBe(true);
    expect(assigned(keydown(BUILT_IN))).toBe(false);
  });
});
