import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chordFor, shouldEscapeTerminal } from "./shortcuts";
import type { Command } from "./commands";
import { keymapConflicts } from "./keymapAssign";
import {
  assignOverride,
  builtInChordSuperseded,
  clearOverride,
  commandIdForChord,
  currentSlot,
  formattedChordForSlot,
  hydrateOverrides,
  overrideChordFor,
  overrideChordForSlot,
  registerOverridePersist,
  resolvedKeymapEntries,
  resolvedKeymapEntriesForSlot,
  serializeOverrides,
} from "./keymapOverrides.svelte";

// Importing the store registers its resolver with shortcuts.ts, so chordFor
// is override-aware for this whole test file (vitest isolates files).

function cmd(id: string, extra: Partial<Command> = {}): Command {
  return {
    id,
    title: id,
    category: "Global",
    requirement: "any",
    available: () => true,
    run: () => {},
    ...extra,
  };
}

function tauri(on: boolean): void {
  const w = window as typeof window & { __TAURI__?: unknown };
  if (on) w.__TAURI__ = {};
  else delete w.__TAURI__;
}

describe("keymap override store", () => {
  beforeEach(() => {
    // Web mac by default (no Tauri global -> web slot).
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    tauri(false);
  });
  afterEach(() => {
    hydrateOverrides(null);
    registerOverridePersist(null);
    tauri(false);
    vi.unstubAllGlobals();
  });

  test("currentSlot follows the client: browser -> web, desktop -> native OS", () => {
    expect(currentSlot()).toBe("web");
    tauri(true);
    expect(currentSlot()).toBe("macos");
    vi.stubGlobal("navigator", { userAgent: "Windows" });
    expect(currentSlot()).toBe("windows");
  });

  test("assign makes chordFor resolve the override over the built-in", () => {
    // app.window.reload built-in is Cmd+R on web mac.
    expect(chordFor("app.window.reload")).toBe("Cmd+R");
    assignOverride("app.window.reload", "Mod+J");
    expect(overrideChordFor("app.window.reload")).toBe("Mod+J");
    expect(chordFor("app.window.reload")).toBe("Cmd+J");
  });

  test("clear restores the built-in chord", () => {
    assignOverride("app.window.reload", "Mod+J");
    clearOverride("app.window.reload");
    expect(overrideChordFor("app.window.reload")).toBeUndefined();
    expect(chordFor("app.window.reload")).toBe("Cmd+R");
  });

  test("an override targets only the current client's slot", () => {
    // Assigned as a browser (web slot). A desktop mac client must not see it.
    assignOverride("app.window.reload", "Mod+J");
    expect(chordFor("app.window.reload")).toBe("Cmd+J");
    tauri(true); // now a desktop mac client -> macos slot, unassigned
    expect(overrideChordFor("app.window.reload")).toBeUndefined();
    expect(chordFor("app.window.reload")).toBe("Cmd+R");
  });

  test("resolvedKeymapEntries is override-first over the SHORTCUTS baseline", () => {
    const commands = [cmd("app.window.reload"), cmd("app.custom.chordless")];
    assignOverride("app.window.reload", "Mod+J");
    assignOverride("app.custom.chordless", "Mod+Y");
    const byId = new Map(
      resolvedKeymapEntries(commands).map((e) => [e.id, e.chord]),
    );
    expect(byId.get("app.window.reload")).toBe("Mod+J"); // override wins
    expect(byId.get("app.launcher.toggle")).toBe("Ctrl+Alt+K"); // baseline
    expect(byId.get("app.custom.chordless")).toBe("Mod+Y"); // chordless override
  });

  test("resolvedKeymapEntries skips read-only command overrides", () => {
    const commands = [
      cmd("app.pane.kill", {
        shortcutEditable: false,
        shortcutIds: ["app.tab.close", "app.window.close"],
      }),
    ];
    assignOverride("app.pane.kill", "Mod+Y");
    const byId = new Map(
      resolvedKeymapEntries(commands).map((e) => [e.id, e.chord]),
    );
    expect(byId.has("app.pane.kill")).toBe(false);
    expect(commandIdForChord("Mod+Y", commands)).toBeUndefined();
  });

  test("commandIdForChord matches an override but not a bare default", () => {
    assignOverride("app.terminal.toggle", "Mod+J");
    expect(commandIdForChord("Mod+J")).toBe("app.terminal.toggle");
    // Cmd+R is app.window.reload's built-in default, not overridden: the
    // compile-time branch owns it, so the override lookup must miss.
    expect(commandIdForChord("Mod+R")).toBeUndefined();
  });

  test("an override equal to the command's own default does not double-fire", () => {
    // Assigning app.window.reload back to its own Cmd+R must NOT surface in
    // the dispatch lookup, or the default branch and this path both fire.
    assignOverride("app.window.reload", "Mod+R");
    expect(commandIdForChord("Mod+R")).toBeUndefined();
  });

  test("builtInChordSuperseded tracks whether an override replaces the default", () => {
    expect(builtInChordSuperseded("app.settings.open")).toBe(false);
    assignOverride("app.settings.open", "Mod+,");
    expect(builtInChordSuperseded("app.settings.open")).toBe(false);
    assignOverride("app.settings.open", "Mod+J");
    expect(builtInChordSuperseded("app.settings.open")).toBe(true);
  });

  test("serialize / hydrate round-trips and drops junk slots", () => {
    assignOverride("app.search.toggle", "Mod+J", "web");
    assignOverride("app.search.toggle", "Cmd+K", "macos");
    const wire = serializeOverrides();
    expect(wire["app.search.toggle"]).toEqual({ web: "Mod+J", macos: "Cmd+K" });

    hydrateOverrides({
      "app.graph.toggle": { web: "Mod+G", bogus: "x" } as never,
      "app.empty": {},
    });
    const after = serializeOverrides();
    expect(after["app.graph.toggle"]).toEqual({ web: "Mod+G" });
    expect(after["app.empty"]).toBeUndefined();
    expect(after["app.search.toggle"]).toBeUndefined(); // hydrate replaces
  });

  test("persist writer receives the serialized wire on every mutation", () => {
    const seen: unknown[] = [];
    registerOverridePersist((wire) => seen.push(wire));
    assignOverride("app.search.toggle", "Mod+J");
    clearOverride("app.search.toggle");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ "app.search.toggle": { web: "Mod+J" } });
    expect(seen[1]).toEqual({});
  });

  test("a user-assigned override chord escapes a focused terminal", () => {
    // Importing the store registers the override-escape matcher. A user
    // assignment must escape so the app key handler can see it from terminal
    // focus.
    const cmdAltJ = () =>
      new KeyboardEvent("keydown", { key: "j", metaKey: true, altKey: true });
    expect(shouldEscapeTerminal(cmdAltJ())).toBe(false); // nothing bound to it
    assignOverride("app.search.toggle", "Mod+Alt+J");
    expect(shouldEscapeTerminal(cmdAltJ())).toBe(true); // override -> escapes
  });

  test("a replacement override stops the old default from escaping terminals", () => {
    const searchDefault = () =>
      new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: true });
    expect(shouldEscapeTerminal(searchDefault())).toBe(true);
    assignOverride("app.search.toggle", "Mod+Alt+J");
    expect(shouldEscapeTerminal(searchDefault())).toBe(false);
  });
});

describe("per-OS slot resolution (the assignment grid)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    tauri(false); // a browser editing all four slots
  });
  afterEach(() => {
    hydrateOverrides(null);
    registerOverridePersist(null);
    tauri(false);
    vi.unstubAllGlobals();
  });

  test("formattedChordForSlot renders each slot's built-in with its OS label", () => {
    // reload built-in: Cmd+R on mac; Ctrl+Shift+R off-mac (shell collision).
    expect(formattedChordForSlot("app.window.reload", "macos")).toBe("Cmd+R");
    expect(formattedChordForSlot("app.window.reload", "linux")).toBe("Ctrl+Shift+R");
    expect(formattedChordForSlot("app.window.reload", "windows")).toBe("Ctrl+Shift+R");
    expect(formattedChordForSlot("app.window.reload", "web")).toBe("Cmd+R");
  });

  test("an override renders in its slot and is independent of the others", () => {
    assignOverride("app.window.reload", "Mod+J", "macos");
    expect(overrideChordForSlot("app.window.reload", "macos")).toBe("Mod+J");
    expect(formattedChordForSlot("app.window.reload", "macos")).toBe("Cmd+J");
    // Other slots untouched: still their built-in.
    expect(overrideChordForSlot("app.window.reload", "web")).toBeUndefined();
    expect(formattedChordForSlot("app.window.reload", "linux")).toBe("Ctrl+Shift+R");
    // A browser client (web slot) is unaffected by a macos assignment.
    expect(formattedChordForSlot("app.window.reload", "web")).toBe("Cmd+R");
  });

  test("formattedChordForSlot is null for an unbound chordless command", () => {
    expect(formattedChordForSlot("app.custom.chordless", "linux")).toBeNull();
    assignOverride("app.custom.chordless", "Mod+Y", "linux");
    expect(formattedChordForSlot("app.custom.chordless", "linux")).toBe("Ctrl+Y");
  });

  test("resolvedKeymapEntriesForSlot resolves against the slot's OS", () => {
    const linux = new Map(
      resolvedKeymapEntriesForSlot([], "linux").map((e) => [e.id, e.chord]),
    );
    // Off-mac divergence surfaces in the raw chord (Mod is still Mod here).
    expect(linux.get("app.window.reload")).toBe("Mod+Shift+R");
    expect(linux.get("app.launcher.toggle")).toBe("Ctrl+Alt+K");
  });
});

describe("slide deck chords (registry + override layer)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    tauri(false);
  });
  afterEach(() => {
    hydrateOverrides(null);
    registerOverridePersist(null);
    tauri(false);
    vi.unstubAllGlobals();
  });

  test("both deck actions resolve their built-in chord on every slot", () => {
    for (const slot of ["web", "macos", "linux", "windows"] as const) {
      const entries = new Map(
        resolvedKeymapEntriesForSlot([], slot).map((e) => [e.id, e.chord]),
      );
      // Same chord on every platform: no osChord divergence for decks.
      expect(entries.get("app.slides.preview")).toBe("Mod+Enter");
      expect(entries.get("app.slides.present")).toBe("Mod+Shift+Enter");
    }
  });

  test("assigning Mod+Enter to another command conflicts, naming deck preview", () => {
    // Before the deck actions were registered this returned empty: no
    // registry entry held Enter, so the assign dialog said nothing.
    const conflicts = keymapConflicts(
      "Mod+Enter",
      resolvedKeymapEntriesForSlot([], "web"),
      "app.search.toggle",
    );
    expect(conflicts.map((c) => c.id)).toEqual(["app.slides.preview"]);
  });

  test("Shift+Tab is assignable to a deck action with no reported conflict", () => {
    // The containment acceptance line's premise: CodeMirror owns Shift-Tab
    // (list outdent) and the registry does not, so the dialog accepts it.
    // What keeps outdent alive on a deck is pinned in
    // editor/wysiwygModEnter.test.ts, not here.
    const conflicts = keymapConflicts(
      "Shift+Tab",
      resolvedKeymapEntriesForSlot([], "web"),
      "app.slides.preview",
    );
    expect(conflicts).toEqual([]);
  });

  test("a rebind supersedes the built-in deck chord and reverse-resolves the new one", () => {
    expect(builtInChordSuperseded("app.slides.preview")).toBe(false);
    assignOverride("app.slides.preview", "Mod+Alt+P");
    // The capture handler keys off this to go inert...
    expect(builtInChordSuperseded("app.slides.preview")).toBe(true);
    // ...and the App-level override path resolves the assigned chord.
    expect(commandIdForChord("Mod+Alt+P", [cmd("app.slides.preview")])).toBe(
      "app.slides.preview",
    );
    // The superseded built-in reverse-resolves to nothing.
    expect(commandIdForChord("Mod+Enter", [cmd("app.slides.preview")])).toBeUndefined();
    // The sibling action's built-in is untouched.
    expect(builtInChordSuperseded("app.slides.present")).toBe(false);
  });
});
