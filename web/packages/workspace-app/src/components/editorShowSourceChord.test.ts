import { describe, expect, test } from "vitest";
import shortcuts from "../state/shortcuts.ts?raw";
import app from "../App.svelte?raw";
import tabs from "../state/tabs.svelte.ts?raw";
import editor from "./FileEditorTab.svelte?raw";

// Mod+E "Show Source Code" chord. Pins: registry entry, keymap handler
// in App.svelte, runCommand branch, and toggleActiveFileTabMode helper
// (mode gate + caret remap). The editor tab menu no longer duplicates
// this command-launcher action.

describe("shortcut registry entry", () => {
  test("app.editor.toggleMode entry exists with Mod+E (web + native)", () => {
    expect(shortcuts).toMatch(
      /id: "app\.editor\.toggleMode",[\s\S]{1,200}label: "Show Source Code \(toggle rendered\/source\)",[\s\S]{1,200}native: "Mod\+E",[\s\S]{1,80}web: "Mod\+E",/,
    );
  });

  test("entry sits in the Editor group + does NOT escape terminal", () => {
    // Off macOS Mod+E is Ctrl+E, which a focused terminal needs for
    // readline (move-to-end-of-line), so the chord must stay inside xterm.
    expect(shortcuts).toMatch(
      /id: "app\.editor\.toggleMode",[\s\S]{1,800}group: "Editor",[\s\S]{1,800}escapeTerminal: false,/,
    );
  });

  test("Editor group added to the ShortcutGroup union", () => {
    expect(shortcuts).toMatch(/export type ShortcutGroup =[\s\S]{1,200}\| "Editor";/);
  });
});

describe("keymap + runCommand routing", () => {
  test("Mod+E hotkey in onWindowKey calls toggleActiveFileTabMode (per-OS)", () => {
    expect(app).toMatch(
      /const toggleModeChord =[\s\S]{1,80}currentOS\(\) === "mac"[\s\S]{1,120}e\.metaKey && !e\.ctrlKey[\s\S]{1,80}shortcutLetter\(e\) === "E"[\s\S]{1,120}: e\.ctrlKey && !e\.metaKey[\s\S]{1,80}shortcutLetter\(e\) === "E";[\s\S]{1,200}toggleActiveFileTabMode\(\);/,
    );
  });

  test("runCommand branch routes app.editor.toggleMode through the same helper", () => {
    expect(app).toMatch(
      /case "app\.editor\.toggleMode":[\s\S]{1,400}toggleActiveFileTabMode\(\);/,
    );
  });

  test("toggleActiveFileTabMode imported from tabs.svelte", () => {
    expect(app).toMatch(
      /import \{[\s\S]{1,4000}toggleActiveFileTabMode,[\s\S]{1,200}\} from "\.\/state\/tabs\.svelte";/,
    );
  });
});

describe("store-side helper", () => {
  test("toggleActiveFileTabMode flips between source and the file's rendered mode", () => {
    // Gated to renderable files via defaultModeForPath (md→wysiwyg, json→pretty,
    // csv→table); source-only files (.rs/.py) yield "source" and the toggle
    // no-ops. Mirrors FileEditorTab's hasRenderedMode / renderedModeForTab gate.
    expect(tabs).toMatch(
      /export function toggleActiveFileTabMode\(\): void \{[\s\S]{1,120}const tab = activeFileTab\(\);[\s\S]{1,120}if \(!tab\) return;[\s\S]{1,300}const rendered = defaultModeForPath\(tab\.path, tab\.fileKind\);[\s\S]{1,120}if \(rendered === "source"\) return;[\s\S]{1,200}const next = tab\.mode === "source" \? rendered : "source";[\s\S]{1,700}setMode\(tab, next\);/,
    );
  });

  test("toggleActiveFileTabMode remaps the caret across the source<->wysiwyg flip (#16)", () => {
    // Only the wysiwyg pair has an offset correspondence; the helper maps
    // tab.caret through caret_mapping and setTabCaret before flipping, so
    // Cmd+E keeps the caret where the right-click "Show Source" path does.
    expect(tabs).toMatch(
      /if \(tab\.caret && rendered === "wysiwyg"\) \{[\s\S]{1,200}renderedCaretForSourceCaret\(tab\.content, tab\.caret\)[\s\S]{1,120}sourceCaretForRenderedCaret\(tab\.content, tab\.caret\)[\s\S]{1,120}setTabCaret\(tab, mapped\.from, mapped\.to\);/,
    );
  });

  test("helper is a no-op when the active tab isn't a file", () => {
    expect(tabs).toMatch(
      /export function toggleActiveFileTabMode\(\): void \{[\s\S]{1,120}const tab = activeFileTab\(\);[\s\S]{1,120}if \(!tab\) return;/,
    );
  });
});

describe("editor tab menu", () => {
  test("Show Source Code row is not duplicated in the tab menu", () => {
    expect(editor).not.toContain('<span class="mbtn-label">Show Source Code</span>');
    expect(editor).not.toContain('chordLabel("app.editor.toggleMode")');
  });
});
