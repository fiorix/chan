import { describe, expect, test } from "vitest";
import tree from "./FileTree.svelte?raw";
import store from "../state/store.svelte.ts?raw";

// FileTree in-tree selection menu: "From selection" header, the
// dir-only "New File or Directory" creation entry, then the per-type
// action rows from the shared classifier (state/fileActions), the
// tree-only file-replacement Upload row for ordinary non-draft
// files, then the tree's separate Copy Path / Rename / Delete
// policy. The classifier rows are variant-independent because every
// handler is tree-local.

describe("FileTree selection menu header + creation entry", () => {
  test("From-selection label rendered at the top of the ctx menu", () => {
    expect(tree).toMatch(
      /\{#if menu\}[\s\S]{1,2000}<div class="from-selection-label">From selection<\/div>/,
    );
  });

  test("Search entry removed (search is workspace-wide via global shortcuts)", () => {
    expect(tree).not.toMatch(/<span>Search<\/span>/);
    expect(tree).not.toMatch(/<span>Search this<\/span>/);
  });

  test("Unified \"New File or Directory\" entry replaces the separate New File / New Directory rows", () => {
    // One entry; the modal detects file-vs-dir from the trailing slash.
    expect(tree).toMatch(/<span>New File or Directory<\/span>/);
    expect(tree).not.toMatch(/<span>New File<\/span>/);
    expect(tree).not.toMatch(/<span>New Directory<\/span>/);
  });
});

describe("FileTree shared-classifier action rows", () => {
  test("rows come from the shared classifier, main first", () => {
    expect(tree).toMatch(
      /import \{[\s\S]*?classifyFileActions,[\s\S]*?\} from "\.\.\/state\/fileActions";/,
    );
    expect(tree).toMatch(/const menuActions = \$derived\.by/);
    expect(tree).toMatch(
      /classifyFileActions\([\s\S]*?path: menu\.path,[\s\S]*?isDir: menu\.isDir,/,
    );
    expect(tree).toMatch(
      /return \[set\.main, \.\.\.set\.secondary\]\.map\(\(id\) =>/,
    );
  });

  test("the menu renders one button per classifier row, keyed by id", () => {
    expect(tree).toMatch(
      /\{#each menuActions as row \(row\.id\)\}[\s\S]*?<button onclick=\{row\.onClick\}>[\s\S]*?<span class="menu-row-label">\{row\.label\}<\/span>/,
    );
  });

  test("rows are variant-independent with no dock gating", () => {
    expect(tree).not.toMatch(/\{#if docked\}/);
    expect(tree).not.toContain("const docked = $derived(");
  });

  test("New Terminal and New Graph keep their labels, handlers, and chords", () => {
    expect(tree).toMatch(
      /label: "New Terminal",[\s\S]{1,120}chord: chordFor\("app\.terminal\.toggle"\) \?\? "",[\s\S]{1,120}onClick: \(\) => terminalFromHere\(path, isDir\)/,
    );
    expect(tree).toMatch(
      /label: "New Graph",[\s\S]{1,120}chord: chordFor\("app\.graph\.toggle"\) \?\? "",[\s\S]{1,120}onClick: \(\) => graphThis\(path, isDir\)/,
    );
    expect(tree).not.toMatch(/<span>Terminal from here<\/span>/);
  });

  test("media view, upload, download, and PDF export rows map to tree-local handlers", () => {
    expect(tree).toMatch(/"View Video"[\s\S]{1,400}void openMediaViewer\(path\)/);
    expect(tree).toMatch(/label: "Upload",[\s\S]{1,160}onClick: \(\) => uploadSelection\(path, isDir\)/);
    expect(tree).toMatch(/label: "Download",[\s\S]{1,160}onClick: \(\) => downloadSelection\(path, isDir\)/);
    expect(tree).toMatch(/label: "Export to PDF",[\s\S]{1,200}void exportPathToPdf\(path\)/);
  });

  test("Open routes files to the editor and directories to a File Browser tab", () => {
    expect(tree).toMatch(
      /case "open":[\s\S]{1,120}label: isDir \? "Open in File Browser" : "Open"/,
    );
    expect(tree).toMatch(
      /if \(isDir\) openSelectionInFileBrowser\(path\);[\s\S]{1,60}else openFileRow\(path\);/,
    );
  });

  test("Open in File Browser spawns a selected tab with inspector open", () => {
    expect(tree).toMatch(/function openSelectionInFileBrowser\(path: string\): void/);
    expect(tree).toMatch(/const tab = openBrowserInActivePane\(\{ select: path \}\)/);
    expect(tree).toMatch(/tab\.inspectorOpen = true/);
    expect(tree).toMatch(/tab\.expanded = ancestors\.length > 0 \? ancestors : undefined/);
  });
});

describe("FileTree destructive + path-mutation policy is separate", () => {
  test("Copy Path / Rename / Delete render outside the classifier rows", () => {
    expect(tree).toMatch(
      /\{\/each\}[\s\S]{1,700}<div class="ctx-sep" role="separator"><\/div>[\s\S]{1,400}<span>Copy Path<\/span>[\s\S]{1,400}<span>Rename \/ Move<\/span>[\s\S]{1,400}<span class="menu-row-label">Delete<\/span>/,
    );
    expect(tree).toMatch(/onclick=\{\(\) => remove\(menu!\.path, menu!\.isDir\)\}/);
  });

  test("delete runs the FileTree -> fileOps -> destructive uiConfirm chain", () => {
    // FileTree delegates to the store's fileOps.remove, which prompts
    // via uiConfirm with destructive styling before any api.remove
    // call. Both hops are pinned so the confirmation cannot be
    // bypassed by a future edit.
    expect(tree).toMatch(
      /async function remove\(path: string, isDir: boolean\): Promise<void> \{\s*await fileOps\.remove\(path, isDir\);/,
    );
    expect(store).toMatch(
      /async remove\(path: string, isDir = false\): Promise<void> \{[\s\S]{1,800}await uiConfirm\(\{[\s\S]{1,160}destructive: true,?\s*\}\)/,
    );
  });

  test("Delete keeps its chord hint from the central store (chordFor)", () => {
    expect(tree).toContain('import { chordFor } from "../state/shortcuts";');
    expect(tree).toMatch(
      /<span class="menu-row-chord">\{chordFor\("app\.files\.delete"\) \?\? ""\}<\/span>/,
    );
    expect(tree).toMatch(
      /<span class="menu-row-chord">\{chordFor\("app\.pane\.flip"\) \?\? ""\}<\/span>/,
    );
  });
});
