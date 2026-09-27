import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureChord, keymapConflicts, type KeymapEntry } from "./keymapAssign";

describe("captureChord", () => {
  beforeEach(() => {
    // macOS so the platform modifier normalises to Mod deterministically.
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
  });
  afterEach(() => vi.unstubAllGlobals());

  test("captures a modified chord in registry grammar", () => {
    const e = new KeyboardEvent("keydown", { key: "j", metaKey: true });
    expect(captureChord(e)).toBe("Mod+J");
  });

  test("captures multi-modifier chords", () => {
    const e = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      shiftKey: true,
    });
    expect(captureChord(e)).toBe("Mod+Shift+K");
  });

  test("returns null while only modifiers are held (still composing)", () => {
    const e = new KeyboardEvent("keydown", { key: "Meta", metaKey: true });
    expect(captureChord(e)).toBeNull();
  });

  test("returns null for a bare key (a rebind needs a modifier)", () => {
    const e = new KeyboardEvent("keydown", { key: "j" });
    expect(captureChord(e)).toBeNull();
  });

  test.each(["K", "1", "F2", "ArrowUp"])(
    "refuses Shift+%s without another modifier",
    (key) => {
      expect(captureChord(new KeyboardEvent("keydown", { key, shiftKey: true }))).toBeNull();
    },
  );
});

describe("keymapConflicts", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
  });
  afterEach(() => vi.unstubAllGlobals());

  const entries: KeymapEntry[] = [
    { id: "app.search.toggle", chord: "Mod+S" },
    { id: "app.launcher.toggle", chord: "Ctrl+Alt+K" },
    { id: "app.terminal.toggle", chord: "Mod+J" },
  ];

  test("reports the command already bound to the candidate", () => {
    const hits = keymapConflicts("Mod+J", entries, "app.draft.new");
    expect(hits.map((h) => h.id)).toEqual(["app.terminal.toggle"]);
  });

  test("no conflict when the candidate is free", () => {
    expect(keymapConflicts("Mod+Y", entries, "app.draft.new")).toEqual([]);
  });

  test("rebinding a command to the chord it already holds is not a conflict", () => {
    expect(keymapConflicts("Mod+J", entries, "app.terminal.toggle")).toEqual([]);
  });

  test("matching is modifier-alias aware (Cmd+J == Mod+J on mac)", () => {
    const hits = keymapConflicts("Cmd+J", entries, "app.draft.new");
    expect(hits.map((h) => h.id)).toEqual(["app.terminal.toggle"]);
  });

  test("finds every command sharing the candidate chord", () => {
    const dupes: KeymapEntry[] = [
      { id: "a", chord: "Mod+G" },
      { id: "b", chord: "Mod+G" },
      { id: "c", chord: "Mod+H" },
    ];
    expect(keymapConflicts("Mod+G", dupes, "a").map((h) => h.id)).toEqual(["b"]);
  });
});
