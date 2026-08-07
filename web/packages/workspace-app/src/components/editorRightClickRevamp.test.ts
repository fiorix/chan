import { describe, expect, test } from "vitest";
import editor from "./FileEditorTab.svelte?raw";

// FileEditorTab right-click menu. Pins: menu-top editable Name input,
// page-width slider, and Close. Editor actions that overlapped with
// the command launcher are intentionally not duplicated in the tab menu;
// body-context actions stay selection/link-aware.

describe("menu-top Name input", () => {
  test("name-row + name-input + name-label rendered inside the action-list", () => {
    expect(editor).toMatch(
      /<div class="action-list">[\s\S]{1,800}<label class="name-row">[\s\S]{1,400}<span class="name-label">[\s\S]{1,400}<input[\s\S]{1,800}class="name-input"/,
    );
  });

  test("Page width follows Name after the first separator", () => {
    expect(editor).toMatch(
      /<div class="action-list">[\s\S]{1,1200}<label class="name-row">[\s\S]{1,1400}<\/label>[\s\S]{1,120}\{#if showPageWidthMenuRow\}\s*<div class="msep" role="separator"><\/div>\s*<!-- Page-width slider:[\s\S]{1,400}<div class="page-width-row">/,
    );
  });

  test("input is bound to nameDraft + commits on blur via commitTabName", () => {
    expect(editor).toMatch(
      /bind:value=\{nameDraft\}[\s\S]{1,400}onkeydown=\{onTabNameKey\}[\s\S]{1,200}onblur=\{commitTabName\}/,
    );
  });

  test("Draft tabs replace the Name row with Save to Workspace", () => {
    expect(editor).toMatch(/const isDraftEditorTab = \$derived/);
    expect(editor).toMatch(
      /\{#if isDraftEditorTab\}[\s\S]{1,500}onclick=\{doSaveDraftToWorkspace\}[\s\S]{1,300}<span class="mbtn-label">Save to Workspace<\/span>/,
    );
    expect(editor).toMatch(/saveDraftTabToWorkspace\(tab\)/);
  });
});

describe("tab-menu foot", () => {
  test("Page width is followed by file actions and Close", () => {
    expect(editor).toMatch(
      /<div class="page-width-row">[\s\S]{1,900}<\/div>\s*\{\/if\}\s*<div class="msep" role="separator"><\/div>\s*<button class="mbtn" onclick=\{\(\) => void doCopyPathToFile\(\)\}>[\s\S]{1,350}<span class="mbtn-label">Copy path to file<\/span>[\s\S]{1,500}<span class="mbtn-label">Delete<\/span>[\s\S]{1,500}<span class="mbtn-label">Duplicate<\/span>[\s\S]{1,300}<span class="mbtn-label">Reload from disk<\/span>[\s\S]{1,300}<button class="mbtn" onclick=\{doCloseTab\}>[\s\S]{1,300}<span class="mbtn-label">Close<\/span>/,
    );
  });

  test("Page width is hidden for Excalidraw canvas tabs as one conditional block", () => {
    expect(editor).toMatch(
      /const showPageWidthMenuRow = \$derived\(tab\.mode !== "canvas"\);/,
    );
    expect(editor).toMatch(
      /\{#if showPageWidthMenuRow\}[\s\S]{1,1200}<div class="page-width-row">[\s\S]{1,1200}\{\/if\}\s*<div class="msep" role="separator"><\/div>\s*<button class="mbtn" onclick=\{\(\) => void doCopyPathToFile\(\)\}>/,
    );
  });

  test("page-width-row draws no separator of its own (single line above Copy path)", () => {
    // The separator between Page width and Copy path to file is the single
    // .msep in the markup; a border-bottom on .page-width-row would render
    // as a second line right under it.
    expect(editor).not.toMatch(/\.page-width-row \{[^}]*border-bottom/);
  });

  test("Close shows the close-tab chord with a canvas macOS Cmd+W override", () => {
    expect(editor).toMatch(
      /function closeTabMenuChordLabel\(\): string \{[\s\S]{1,220}if \(tab\.mode === "canvas" && currentOS\(\) === "mac"\) return "Cmd\+W";[\s\S]{1,120}return chordLabel\("app\.tab\.close"\);/,
    );
    expect(editor).toMatch(
      /<span class="mbtn-label">Close<\/span>\s*<span class="mbtn-chord">\{closeTabMenuChordLabel\(\)\}<\/span>/,
    );
  });
});

describe("body menu Find", () => {
  test("doFind opens the per-tab find bar via openFind(tab.id)", () => {
    expect(editor).toMatch(
      /function doFind\(\): void \{[\s\S]{1,200}closeTabMenu\(\);[\s\S]{1,200}openFind\(tab\.id\)/,
    );
  });

  test("Find button rendered with chord hint", () => {
    expect(editor).toMatch(
      /onclick=\{doFind\}[\s\S]{1,400}<span class="mbtn-label">Find<\/span>/,
    );
  });
});

describe("dropped entries", () => {
  test("Close others / Close all entries dropped (per spec)", () => {
    expect(editor).not.toMatch(/<span class="mbtn-label">Close others<\/span>/);
    expect(editor).not.toMatch(/<span class="mbtn-label">Close all<\/span>/);
  });

  test("\"Rename File\" entry dropped (replaced by menu-top Name input)", () => {
    expect(editor).not.toMatch(/<span class="mbtn-label">Rename File<\/span>/);
  });

  test("\"Terminal from here\" dropped (replaced by \"New Terminal\" in From-$CWD band)", () => {
    expect(editor).not.toMatch(
      /<span class="mbtn-label">Terminal from here<\/span>/,
    );
  });

  test("\"Copy File Path\" is gone (replaced by \"Copy path to file\")", () => {
    expect(editor).not.toMatch(/<span class="mbtn-label">Copy File Path<\/span>/);
  });

  test("most launcher-overlap rows are gone from the tab menu", () => {
    for (const label of [
      "Show Source Code",
      "Collapse Code Blocks",
      "Expand Code Blocks",
      "Search",
      "Copy path to $CWD",
      "Reload from Disk",
      "New File",
      "New Terminal",
      "New File Browser",
      "New Graph",
      "Settings",
      "Reopen Closed Tab",
    ]) {
      expect(editor).not.toContain(`<span class="mbtn-label">${label}</span>`);
    }
    expect(editor).not.toContain("from-cwd-label");
  });
});

describe("file action group", () => {
  test("Copy path to file, Delete, Duplicate sit alphabetically before Close", () => {
    expect(editor).toMatch(
      /<span class="mbtn-label">Copy path to file<\/span>[\s\S]{1,650}<span class="mbtn-label">Delete<\/span>[\s\S]{1,650}<span class="mbtn-label">Duplicate<\/span>[\s\S]{1,650}<span class="mbtn-label">Close<\/span>/,
    );
  });

  test("file actions reuse fileOps and clipboard helpers", () => {
    expect(editor).toMatch(
      /function doCopyPathToFile\(\): Promise<void> \{[\s\S]{1,300}copyTextToClipboard\(tab\.path/,
    );
    expect(editor).toMatch(
      /function doDeleteFile\(\): Promise<void> \{[\s\S]{1,220}fileOps\.remove\(tab\.path, false\)/,
    );
    expect(editor).toMatch(
      /function doDuplicateFile\(\): Promise<void> \{[\s\S]{1,220}fileOps\.duplicateFile\(tab\.path\)/,
    );
  });
});

describe("imports", () => {
  test("openFind imported from tabs.svelte", () => {
    expect(editor).toMatch(
      /import \{[\s\S]{1,2000}openFind,[\s\S]{1,800}\} from "\.\.\/state\/tabs\.svelte";/,
    );
  });
});

describe("editor body-context vs tab-context split", () => {
  test("body right-click opens the body source", () => {
    expect(editor).toMatch(
      /function onEditorContext[\s\S]{1,500}openTabMenu\([\s\S]{1,300}"body",/,
    );
  });

  test("body menu is the tight Cut / Copy / Paste + Find set", () => {
    expect(editor).toContain('{#if tabMenu.source === "body"}');
    expect(editor).toMatch(
      /tabMenu\.source === "body"[\s\S]{1,1500}onclick=\{doCutSelection\}[\s\S]{1,600}onclick=\{doCopySelection\}[\s\S]{1,600}onclick=\{doPasteClipboard\}[\s\S]{1,1800}onclick=\{doFind\}/,
    );
  });

  test("Cut gates on a text selection; Copy also enables for a selected image", () => {
    expect(editor).toMatch(
      /onclick=\{doCutSelection\}[\s\S]{1,120}disabled=\{!bodyHasSelection\}/,
    );
    // Copy widens to bodyCanCopy so a ring-selected image (empty text
    // selection) can still copy its markdown source.
    expect(editor).toMatch(
      /onclick=\{doCopySelection\}[\s\S]{1,120}disabled=\{!bodyCanCopy\}/,
    );
    expect(editor).toMatch(
      /bodyCanCopy = \$derived\([\s\S]{1,80}bodyImageMarkdown !== null\)/,
    );
  });

  test("clipboard actions route to the active editor ref", () => {
    expect(editor).toMatch(
      /function activeEditorRef\(\)[\s\S]{1,200}tab\.mode === "source" \? sourceRef : wysiwygRef/,
    );
    expect(editor).toMatch(/activeEditorRef\(\)\?\.cutSelection\(\)/);
    expect(editor).toMatch(/activeEditorRef\(\)\?\.copySelection\(\)/);
    expect(editor).toMatch(/activeEditorRef\(\)\?\.pasteClipboard\(\)/);
  });
});

describe("link affordances (editor body menu)", () => {
  test("link state is captured at right-click, before the menu covers it", () => {
    // elementFromPoint would resolve the menu portal once it is on
    // screen, so onEditorContext samples the link under the cursor first.
    expect(editor).toMatch(
      /function onEditorContext[\s\S]{1,400}externalUrlAtCoords\(e\.clientX, e\.clientY\)[\s\S]{1,200}internalLinkAtPoint\(e\.clientX, e\.clientY\)[\s\S]{1,200}openTabMenu/,
    );
  });

  test("Open link / Copy link show only on an external URL (#3 = A, no bubble)", () => {
    expect(editor).toMatch(
      /\{#if bodyLinkUrl\}[\s\S]{1,400}onclick=\{doOpenLink\}[\s\S]{1,400}onclick=\{doCopyLink\}/,
    );
    expect(editor).toMatch(/function doOpenLink[\s\S]{1,160}openExternalUrl\(url\)/);
    expect(editor).toMatch(/doCopyLink[\s\S]{1,200}copyTextToClipboard\(url/);
  });

  test("Preview shows only on an internal wiki link (#4) + reuses the popover", () => {
    expect(editor).toMatch(
      /\{#if bodyPreviewHit\}[\s\S]{1,300}onclick=\{doPreviewLink\}/,
    );
    expect(editor).toMatch(
      /function doPreviewLink[\s\S]{1,300}openLinkPreview\(\{[\s\S]{1,200}openInActivePane\(hit\.target\)/,
    );
  });
});
