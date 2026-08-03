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

  test("directory pill is Open -> a new File Browser tab", () => {
    expect(fileInfo).toMatch(
      /if \(isDir\) \{[\s\S]{1,80}main = \{ label: "Open", onClick: openDirInBrowser \}/,
    );
    // openDirInBrowser prefers the host onReveal, else reveals a new tab.
    expect(fileInfo).toMatch(
      /function openDirInBrowser\(\): void \{[\s\S]{1,200}revealPathInBrowser\(entry\.path, \{ enter: true/,
    );
  });

  test("media pill keeps per-kind labels over the shared media router", () => {
    expect(fileInfo).toMatch(
      /label: image[\s\S]{1,220}"View \/ Zoom"[\s\S]{1,220}"View Video"[\s\S]{1,220}"View Audio"[\s\S]{1,220}"View PDF"[\s\S]{1,100}onClick: \(\) => void openMediaViewer\(p\)/,
    );
  });

  test("editable file pill is Open (onOpen) or Show file (editor Show Details)", () => {
    // FB / search bind onOpen -> "Open" (Hybrid Editor).
    expect(fileInfo).toMatch(
      /if \(onOpen\) \{[\s\S]{1,80}main = \{ label: "Open", onClick: onOpen \}/,
    );
    // Editor "Show Details" binds no onOpen -> "Show file" via onReveal.
    expect(fileInfo).toMatch(
      /\} else if \(onReveal\) \{[\s\S]{1,120}main = \{ label: "Show file", onClick: onReveal \}/,
    );
  });

  test("binary (incl symlinks) pill is Download file, dropdown only Graph", () => {
    // The else branch (not dir / media / editable) makes download the main
    // action; Graph from here is the only secondary it offers.
    expect(fileInfo).toMatch(
      /\} else \{[\s\S]{1,120}main = download;[\s\S]{1,80}if \(graph\) secondary\.push\(graph\)/,
    );
    expect(fileInfo).toMatch(
      /label: isDir \? "Download tarball" : "Download file",[\s\S]{1,80}onClick: downloadSelection/,
    );
  });

  test("markdown files carry an Export to PDF secondary action", () => {
    // Gated on isMarkdown (never a directory), unconditional across web
    // and desktop; only the save path differs inside the handler.
    expect(fileInfo).toMatch(
      /!isDir && isMarkdown\(p\)[\s\S]{1,80}label: "Export to PDF", onClick: exportSelectionToPdf/,
    );
    // The editable branch surfaces it in the dropdown.
    expect(fileInfo).toMatch(
      /secondary\.push\(download, newTerminal\);[\s\S]{1,60}if \(exportPdf\) secondary\.push\(exportPdf\);/,
    );
    // The handler branches desktop Downloads vs the shared web helper.
    expect(fileInfo).toMatch(
      /async function exportSelectionToPdf\(\): Promise<void> \{[\s\S]{1,900}saveBytesToDownloads\(bytes, filename\)[\s\S]{1,200}downloadBytes\(bytes, filename, "application\/pdf"\)/,
    );
    expect(fileInfo).toMatch(
      /import \{ downloadBytes \} from "\.\.\/api\/download";/,
    );
  });

  test("New terminal here is a secondary action seeded via fromHere", () => {
    expect(fileInfo).toMatch(
      /label: "New terminal here",[\s\S]{1,40}onClick: newTerminalHere,/,
    );
    expect(fileInfo).toMatch(
      /function newTerminalHere\(\): void \{[\s\S]{1,200}terminalFromHereTarget\(entry\.path, entry\.is_dir\)/,
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
