import { describe, expect, test } from "vitest";
import pane from "./Pane.svelte?raw";
import fileEditorTab from "./FileEditorTab.svelte?raw";

// File tabs are kept ALIVE, exactly like terminals (see
// paneTerminalMount.test.ts): Pane.svelte renders every file tab from
// an all-pane each-block and flips an `active` prop; the
// inactive editors hide via `visibility: hidden` (never display:none,
// so CM6 keeps real layout geometry while hidden). Unmount-on-switch
// was the root cause of the WKWebView raw-markdown flash + scroll
// reset: a remounted EditorView computes decorations from a
// pre-layout viewport and persists no scroll context. These pins
// catch any regression back to render-only-the-active-file-tab.

describe("file tabs survive tab switches (keep-alive)", () => {
  // The mounting and the keying are asserted in paneKeepAliveMount.test.ts,
  // which mounts two file tabs, switches, reorders, and compares the DOM
  // nodes. The pins below cover the props each body is handed.

  test("file tabs no longer mount from the active-tab if-chain", () => {
    // The pre-fix branch mounted ONLY the active file tab
    // (`<FileEditorTab tab={active} ...>` under
    // `{:else if active?.kind === "file"}`), so every switch destroyed
    // and recreated the EditorView. What must not return is a
    // FileEditorTab mounted off `active`.
    expect(pane).not.toMatch(/<FileEditorTab\s+tab=\{active\}/);
  });

  test("active prop is gated by pane mode + visible-side active tab", () => {
    expect(pane).toMatch(
      /<FileEditorTab\s+tab=\{t\}\s+active=\{isLiveActive\(t\)\}/,
    );
  });

  test("focused prop adds the active-pane gate on top of the active gates", () => {
    expect(pane).toMatch(
      /<FileEditorTab\s+tab=\{t\}\s+active=\{[^}]*\}\s+focused=\{isLiveActive\(t\) && viewLayout\.activePaneId === pane\.id\}\s*\/>/,
    );
  });

  test("no {#key tab.id} remount wrapper remains", () => {
    // The keyed each-block already gives one component instance per
    // tab id; a leftover {#key} would reintroduce remount-on-switch
    // for state the key expression touches.
    expect(fileEditorTab).not.toMatch(/\{#key tab\.id\}/);
  });

  test("root carries the keep-alive contract: class:active + tabpanel + aria-hidden", () => {
    expect(fileEditorTab).toMatch(
      /class="editor-tab"\s+class:active\s+bind:this=\{editorTabEl\}\s+role="tabpanel"\s+aria-hidden=\{!active\}/,
    );
  });

  test("hidden editors keep layout via visibility, not display:none", () => {
    expect(fileEditorTab).toMatch(
      /\.editor-tab \{[^}]*position: absolute;[^}]*inset: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*\}/,
    );
    expect(fileEditorTab).toMatch(
      /\.editor-tab\.active \{\s*visibility: visible;\s*pointer-events: auto;\s*\}/,
    );
  });

  test("mount autofocus is gated on focused for both editor modes", () => {
    // Wysiwyg/Source default autoFocus=true; ungated, every background
    // editor mounted at session restore would focus at mount + rAF and
    // the caret would land in a random hidden tab.
    expect(fileEditorTab).toMatch(
      /<Wysiwyg\s+bind:this=\{wysiwygRef\}\s+bind:value=\{tab\.content\}\s+autoFocus=\{focused\}/,
    );
    expect(fileEditorTab).toMatch(
      /<Source\s+bind:this=\{sourceRef\}\s+bind:value=\{tab\.content\}\s+autoFocus=\{focused\}/,
    );
  });

  test("becoming active without focus still nudges a CM6 re-measure", () => {
    // Mirrors TerminalTab's active-flip recovery: flip-back and
    // pane-mode exit make a tab visible without focusing it, and the
    // visibility flip alone fires no resize/focus event.
    expect(fileEditorTab).toMatch(
      /\$effect\(\(\) => \{\s*if \(!active\) return;\s*wysiwygRef\?\.remeasure\(\);\s*sourceRef\?\.remeasure\(\);\s*\}\);/,
    );
    expect(fileEditorTab).toMatch(/let \{ tab, active = false, focused = false \}/);
  });
});
