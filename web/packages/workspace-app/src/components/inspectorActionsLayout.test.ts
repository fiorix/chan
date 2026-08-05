import { describe, expect, test } from "vitest";
import fileInfo from "./FileInfoBody.svelte?raw";

// The inspector renders one consistent layout on every surface:
//   header -> actions section -> lazy content (report / refs).
// The actions are a single PILL (primary action) plus a caret that drops
// the secondary actions, chosen per item category (directory / media /
// editable file / binary) and per surface (the editor "Show Details"
// inspector has no onOpen, so its file pill is "Show file"). A full-path
// toggle sits above the pill. These source pins lock that contract so the
// layout can't silently drift.

describe("shared actions section under the filename", () => {
  test("defines a reusable actionsSection snippet driven by actionModel", () => {
    expect(fileInfo).toMatch(/\{#snippet actionsSection\(\)\}/);
    expect(fileInfo).toMatch(/<div class="actions-section">/);
    // The category logic lives in the script (actionModel), not inline.
    expect(fileInfo).toMatch(/const actionModel = \$derived\.by</);
  });

  test("actions section carries the full-path toggle + revealed path row", () => {
    expect(fileInfo).toMatch(
      /class="path-toggle"[\s\S]*?onclick=\{\(\) => \(showFullPath = !showFullPath\)\}/,
    );
    expect(fileInfo).toMatch(
      /\{#if showFullPath\}[\s\S]*?<div class="path-row mono"/,
    );
    // The toggle state resets when the selection changes.
    expect(fileInfo).toMatch(/showFullPath = false;/);
  });

  test("renders a pill (primary) + caret that toggles the dropdown", () => {
    expect(fileInfo).toMatch(
      /<button[\s\S]*?class="pill-main"[\s\S]*?onclick=\{actionModel\.main\.onClick\}[\s\S]*?\{actionModel\.main\.label\}/,
    );
    // Caret only renders when there are secondary actions, and toggles the menu.
    expect(fileInfo).toMatch(
      /\{#if actionModel\.secondary\.length > 0\}[\s\S]*?class="pill-caret"[\s\S]*?onclick=\{\(\) => \(menuOpen = !menuOpen\)\}/,
    );
  });

  test("dropdown lists the secondary actions as menu items", () => {
    expect(fileInfo).toMatch(
      /\{#if menuOpen && actionModel\.secondary\.length > 0\}[\s\S]*?<div class="action-menu" role="menu">/,
    );
    expect(fileInfo).toMatch(
      /\{#each actionModel\.secondary as item[\s\S]*?class="action-menu-item"[\s\S]*?item\.onClick\(\)/,
    );
    // Selecting an item closes the menu.
    expect(fileInfo).toMatch(/menuOpen = false;[\s\S]{1,40}item\.onClick\(\);/);
  });

  test("applicability comes from the shared classifier, capabilities from the host", () => {
    // The inspector does not decide WHICH actions exist; it feeds the
    // entry facts + host-bound capabilities into classifyFileActions
    // (the same policy the FileTree menu consumes) and maps the ids.
    expect(fileInfo).toMatch(
      /import \{[\s\S]*?classifyFileActions,[\s\S]*?\} from "\.\.\/state\/fileActions";/,
    );
    expect(fileInfo).toMatch(
      /const set = classifyFileActions\([\s\S]*?path: entry\.path,[\s\S]*?isDir: entry\.is_dir,[\s\S]*?serverKind: entry\.kind,[\s\S]*?isDraft: entry\.path === draftsDir\(\) \|\| isDraftPath\(entry\.path\),/,
    );
    expect(fileInfo).toMatch(
      /open: !!onOpen,[\s\S]*?reveal: !!onReveal,[\s\S]*?graph: !!onSetAsScope,[\s\S]*?upload: allowUpload,/,
    );
    expect(fileInfo).toMatch(
      /return \{ main: actionFor\(set\.main\), secondary: set\.secondary\.map\(actionFor\) \};/,
    );
  });

  test("directory pill is Open -> a new File Browser tab", () => {
    expect(fileInfo).toMatch(
      /case "open":[\s\S]{1,160}\{ label: "Open", onClick: openDirInBrowser \}/,
    );
    // openDirInBrowser prefers the host onReveal, else reveals a new tab.
    expect(fileInfo).toMatch(
      /function openDirInBrowser\(\): void \{[\s\S]{1,200}revealPathInBrowser\(entry\.path, \{ enter: true/,
    );
  });

  test("media pill keeps per-kind labels over the shared media router", () => {
    expect(fileInfo).toMatch(
      /case "viewMedia":[\s\S]{1,400}"View \/ Zoom"[\s\S]{1,220}"View Video"[\s\S]{1,220}"View Audio"[\s\S]{1,220}"View PDF"[\s\S]{1,100}onClick: \(\) => void openMediaViewer\(p\)/,
    );
  });

  test("download / upload / graph map to the inspector handlers with their labels", () => {
    expect(fileInfo).toMatch(
      /case "download":[\s\S]{1,200}label: e\.is_dir \? "Download tarball" : "Download file",[\s\S]{1,120}onClick: downloadSelection/,
    );
    expect(fileInfo).toMatch(
      /case "upload":[\s\S]{1,160}label: "Upload file here", onClick: triggerUpload/,
    );
    expect(fileInfo).toMatch(
      /case "graphFromHere":[\s\S]{1,160}label: "Graph from here", onClick: \(\) => onSetAsScope\?\.\(\)/,
    );
  });

  test("markdown Export to PDF rides the shared executor", () => {
    // The operation lives in state/fileActionExecutors so the FileTree
    // context menu exports the same way; the inspector delegates.
    expect(fileInfo).toMatch(
      /import \{ exportPathToPdf \} from "\.\.\/state\/fileActionExecutors";/,
    );
    expect(fileInfo).toMatch(
      /async function exportSelectionToPdf\(\): Promise<void> \{[\s\S]{1,160}await exportPathToPdf\(entry\.path\);/,
    );
    expect(fileInfo).toMatch(
      /case "exportPdf":[\s\S]{1,120}label: "Export to PDF", onClick: exportSelectionToPdf/,
    );
  });

  test("New terminal here maps to the fromHere helper, draft files to the abs-path seed", () => {
    // Draft directories root the terminal in the directory via
    // newTerminalHere; only draft files take the abs-path seed.
    expect(fileInfo).toMatch(
      /case "newTerminal":[\s\S]{1,450}\{ label: "Terminal from here", onClick: newTerminalHere \}[\s\S]{1,120}\{ label: "Terminal from here", onClick: draftTerminalHere \}[\s\S]{1,120}\{ label: "New terminal here", onClick: newTerminalHere \}/,
    );
    expect(fileInfo).toMatch(
      /function newTerminalHere\(\): void \{[\s\S]{1,200}terminalFromHereTarget\(entry\.path, entry\.is_dir\)/,
    );
    expect(fileInfo).toMatch(
      /function draftTerminalHere\(\): void \{[\s\S]{1,300}shellQuotePath\(draftAbs\)/,
    );
    expect(fileInfo).toMatch(
      /import \{[^}]*\bterminalFromHereTarget\b[^}]*\} from "\.\.\/terminal\/fromHere";/,
    );
    expect(fileInfo).toMatch(
      /import \{ openTerminalInActivePane \} from "\.\.\/state\/tabs\.svelte";/,
    );
  });

  test("dir branch renders actions BEFORE the dir stats meta-grid", () => {
    // The dir branch order is: ... badges -> {@render actionsSection()}
    // -> {#if dirStats} meta-grid. The actions must precede the stats.
    const actionsIdx = fileInfo.indexOf("{@render actionsSection()}");
    const dirStatsIdx = fileInfo.indexOf("{#if dirStats}");
    expect(actionsIdx).toBeGreaterThan(0);
    expect(dirStatsIdx).toBeGreaterThan(actionsIdx);
  });

  test("file branch renders actions BEFORE the size/modified meta-grid", () => {
    // The file branch renders the (optional) image preview, then
    // {@render actionsSection()}, then the size/modified meta-grid.
    const lastActions = fileInfo.lastIndexOf("{@render actionsSection()}");
    const sizeGrid = fileInfo.indexOf(
      '<span class="k">size</span>',
      lastActions,
    );
    expect(lastActions).toBeGreaterThan(0);
    expect(sizeGrid).toBeGreaterThan(lastActions);
  });

  test("actions live only in the reusable section, not standalone bottom blocks", () => {
    // The pill is defined once inside actionsSection and rendered via
    // {@render actionsSection()}; there is no separate bottom-of-body
    // action block to drift out of sync.
    const sectionDefs = fileInfo.match(/<div class="actions-section">/g) ?? [];
    expect(sectionDefs.length).toBe(1);
    expect(fileInfo).toMatch(/\{@render actionsSection\(\)\}/);
  });
});
