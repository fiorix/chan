// The layout-aware matching contract: one keydown identity from the shared
// helper, the exact chord first and a Shift-consumed chord second, and one
// winner for dispatch, terminal escape and shortcut capture. Every case runs
// the real matcher on a keydown from a published layout.

import { afterEach, describe, expect, test, vi } from "vitest";
import { KEY_VECTORS, keyVectorEvent, type KeyVector } from "@chan/web-shared/keyboard-vectors";
import {
  chordFromEvent,
  chordsEqual,
  eventChordCandidates,
  eventMatchesShortcut,
  resolveEventChord,
  resolvedEventKey,
  shouldEscapeTerminal,
} from "./shortcuts";
import { captureCandidates, captureChord, keymapConflicts } from "./keymapAssign";
import {
  assignOverride,
  hydrateOverrides,
  resolvedKeymapEntriesForSlot,
} from "./keymapOverrides.svelte";
import { allCommands } from "./commands";
import "./commands/install";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

function useUserAgent(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  hydrateOverrides(null);
  vi.restoreAllMocks();
});

/// The chords the grammar says a vector names with the platform modifier
/// held: exact first, then the Shift-consumed form when Shift only typed a
/// base punctuation symbol.
function expectedCandidates(v: KeyVector): string[] {
  if (v.key === null) return [];
  const mods = ["Mod"];
  if (v.mac && v.event.ctrlKey) mods.push("Ctrl");
  if (v.event.altKey) mods.push("Alt");
  const shift = (v.event.shiftKey ?? false) || (v.shifted ?? false);
  const exact = [...mods, ...(shift ? ["Shift"] : []), v.key].join("+");
  if (v.event.shiftKey && v.consumable) return [exact, [...mods, v.key].join("+")];
  return [exact];
}

describe("chord candidates for every layout vector", () => {
  test.each(KEY_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    useUserAgent(v.mac ? MAC_UA : LINUX_UA);
    const mod = v.mac ? { metaKey: true } : { ctrlKey: true };
    expect(eventChordCandidates(keyVectorEvent(v, mod))).toEqual(expectedCandidates(v));
  });
});

describe("one winner for dispatch and terminal escape", () => {
  test("AZERTY Ctrl+Shift+. on Comma resolves to Hybrid Nav's Mod+. and escapes", () => {
    useUserAgent(LINUX_UA);
    const e = key({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true });
    expect(chordFromEvent(e)).toBe("Mod+Shift+.");
    expect(resolveEventChord(e)).toBe("Mod+.");
    expect(resolvedEventKey(e)).toEqual({ key: ".", shiftKey: false });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("US Ctrl+Shift+. types > and keeps its Shift", () => {
    useUserAgent(LINUX_UA);
    const e = key({ key: ">", code: "Period", ctrlKey: true, shiftKey: true });
    expect(eventChordCandidates(e)).toEqual(["Mod+Shift+."]);
    expect(resolveEventChord(e)).toBe("Mod+Shift+.");
    expect(shouldEscapeTerminal(e)).toBe(false);
  });

  test("an explicitly shifted chord beats the consumed one: AZERTY / splits down", () => {
    useUserAgent(LINUX_UA);
    const e = key({ key: "/", code: "Period", ctrlKey: true, altKey: true, shiftKey: true });
    expect(eventChordCandidates(e)).toEqual(["Mod+Alt+Shift+/", "Mod+Alt+/"]);
    expect(resolveEventChord(e)).toBe("Mod+Alt+Shift+/");
    expect(chordsEqual(resolveEventChord(e)!, "Ctrl+Alt+?")).toBe(true);
  });

  test("an override on the exact chord beats the registry on the consumed one", () => {
    useUserAgent(LINUX_UA);
    assignOverride("app.settings.open", "Mod+Shift+.", "web");
    const e = key({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true });
    expect(resolveEventChord(e)).toBe("Mod+Shift+.");
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Dvorak , on KeyW escapes as Settings; the W on Comma does not name Mod+,", () => {
    useUserAgent(LINUX_UA);
    expect(shouldEscapeTerminal(key({ key: ",", code: "KeyW", ctrlKey: true }))).toBe(true);
    expect(resolveEventChord(key({ key: "w", code: "Comma", ctrlKey: true }))).toBe("Mod+W");
  });

  test("Dvorak Ctrl+Alt+/ on BracketLeft escapes as split right; the Z on Slash does not", () => {
    useUserAgent(LINUX_UA);
    expect(
      shouldEscapeTerminal(key({ key: "/", code: "BracketLeft", ctrlKey: true, altKey: true })),
    ).toBe(true);
    expect(
      shouldEscapeTerminal(key({ key: "z", code: "Slash", ctrlKey: true, altKey: true })),
    ).toBe(false);
  });

  test("terminal find follows the layout letter", () => {
    useUserAgent(LINUX_UA);
    // Off macOS terminal find is Ctrl+Shift+F. Colemak F sits on KeyE.
    const colemakF = key({ key: "F", code: "KeyE", ctrlKey: true, shiftKey: true });
    const colemakT = key({ key: "T", code: "KeyF", ctrlKey: true, shiftKey: true });
    expect(eventMatchesShortcut(colemakF, "terminal.find")).toBe(true);
    expect(eventMatchesShortcut(colemakT, "terminal.find")).toBe(false);
  });

  test("AltGr character entry escapes nothing", () => {
    useUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const e = new KeyboardEvent("keydown", {
      key: "[",
      code: "Digit8",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    expect(resolveEventChord(e)).toBeNull();
    expect(shouldEscapeTerminal(e)).toBe(false);
  });
});

describe("stored chords fold shifted glyphs the way keydowns do", () => {
  test.each([
    ["Mod+{", "Mod+Shift+[", true],
    ["Alt+}", "Alt+Shift+]", true],
    ["Ctrl+Alt+?", "Ctrl+Alt+Shift+/", true],
    ["Mod+Shift+.", "Mod+.", false],
  ] as const)("%s vs %s", (a, b, equal) => {
    useUserAgent(LINUX_UA);
    expect(chordsEqual(a, b)).toBe(equal);
  });
});

describe("capture reports the command the keystroke reaches today", () => {
  test("AZERTY Ctrl+Shift+. stores the exact chord and names Hybrid Nav as the holder", () => {
    useUserAgent(LINUX_UA);
    const e = key({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true });
    expect(captureChord(e)).toBe("Mod+Shift+.");
    const entries = resolvedKeymapEntriesForSlot(allCommands(), "web");
    const holders = keymapConflicts(captureCandidates(e), entries, "app.draft.new");
    expect(holders.map((h) => h.id)).toEqual(["app.pane.mode"]);
  });

  test("US Ctrl+Shift+. is free: its Shift is not consumed", () => {
    useUserAgent(LINUX_UA);
    const e = key({ key: ">", code: "Period", ctrlKey: true, shiftKey: true });
    const entries = resolvedKeymapEntriesForSlot(allCommands(), "web");
    expect(keymapConflicts(captureCandidates(e), entries, "app.draft.new")).toEqual([]);
  });

  test("a holder of the exact chord is reported, not the consumed chord's", () => {
    useUserAgent(LINUX_UA);
    const entries = [
      { id: "exact", chord: "Mod+Shift+." },
      { id: "consumed", chord: "Mod+." },
    ];
    expect(keymapConflicts(["Mod+Shift+.", "Mod+."], entries, "other").map((h) => h.id)).toEqual([
      "exact",
    ]);
  });

  test("the command already holding the exact chord has no conflict", () => {
    useUserAgent(LINUX_UA);
    const entries = [
      { id: "exact", chord: "Mod+Shift+." },
      { id: "consumed", chord: "Mod+." },
    ];
    expect(keymapConflicts(["Mod+Shift+.", "Mod+."], entries, "exact")).toEqual([]);
  });
});
