import { describe, expect, test } from "vitest";
import panel from "./GraphPanel.svelte?raw";

// The dir probe's own behaviour, that it asks at the full depth and re-runs
// when the dir scope changes, is asserted against a counting stub in
// graphDepthProbeFailure.svelte.test.ts rather than pinned as source text.
// The discard of a result for a scope that has moved on is not asserted
// anywhere: `dirDepthProbeLoading` keeps a second probe from starting while
// one is in flight, so that guard's case is not reachable from the outside.

// Graph directory-node inspector hotfix. Directory-node actions (Show
// Directory, Graph from here) and the depth slider were broken. These
// source-level pins mirror graphInspectorActionsHotfix's ?raw pattern
// because the handlers live inside the Svelte component.

describe("Show Directory reveals + ENTERS the directory in the File Browser", () => {
  test("the dir-node Open opens a File Browser TAB, expanding the dir itself", () => {
    // The dir "Open" routes through revealPathInBrowserTab(fsPath, true).
    // Directories pass isDir=true so the browser expands the directory
    // itself (upto = parts.length) and opens AT it; files expand ancestors.
    // The dedicated revealSelectedFsEntry helper was deleted; the inspector
    // binds the revealPathInBrowserTab primitive directly.
    expect(panel).toMatch(
      /onReveal=\{fsIsDir \? \(\) => revealPathInBrowserTab\(fsPath, true\) : undefined\}/,
    );
    expect(panel).toMatch(
      /function revealPathInBrowserTab\(path: string, isDir: boolean\)[\s\S]*?const upto = isDir \? parts\.length : parts\.length - 1;/,
    );
  });

  test("the semantic dir-node inspector also reveals the dir via revealPathInBrowserTab", () => {
    // A semantic directory selection's "Open" routes through
    // FileInfoBody's openDirInBrowser → onReveal, spawning a File
    // Browser tab AT the directory (isDir=true).
    expect(panel).toMatch(
      /onReveal=\{\s*inspectorSelection\?\.kind === "directory"[\s\S]*?\(\) => revealPathInBrowserTab\(inspectorSelection\.path, true\)/,
    );
  });
});

describe("Graph from here on a directory re-roots at the dir itself + keeps it selected", () => {
  test("graphFromHere takes an isDir flag and re-roots dirs to the dir itself, files to the parent", () => {
    // Directory: scope to `dir:<path>` (not its parent). The old always-
    // parent rule made re-rooting to the current parent a no-op and left
    // the inspector blank. File: parent-folder rule is kept.
    expect(panel).toMatch(/function graphFromHere\(path: string, isDir: boolean\): void \{/);
    expect(panel).toMatch(/if \(isDir\) \{\s*scopeId = path \? `dir:\$\{path\}` : "workspace";/);
    expect(panel).toMatch(
      /\} else \{\s*const slash = path\.lastIndexOf\("\/"\);\s*const parent = slash > 0 \? path\.slice\(0, slash\) : "";\s*scopeId = parent \? `dir:\$\{parent\}` : "workspace";/,
    );
  });

  test("graphFromHere spawns a new semantic graph tab seeded + pre-selected on the node", () => {
    // The new nav contract: from-here spawns a fresh graph TAB
    // (openGraphInActivePane) rather than re-rooting in place. depth
    // resets to 1 so the new graph starts tight, and pendingSelectId
    // lands it already selected on the clicked node so the inspector
    // stays populated.
    expect(panel).toMatch(
      /openGraphInActivePane\(\{\s*mode: "semantic",\s*scopeId,\s*depth: 1,\s*pendingSelectId: path,\s*\}\)/,
    );
    // The old in-place re-root (mutating the current tab + selectedId)
    // is gone.
    expect(panel).not.toMatch(
      /function graphFromHere[\s\S]*?graphState\.scopeId = scopeId;[\s\S]*?selectedId = path;/,
    );
  });

  test("the fs-node inspector binds onSetAsScope with the directory flag", () => {
    expect(panel).toMatch(/\{@const fsIsDir = isFsDirectory\(selectedFsNode\)\}/);
    expect(panel).toMatch(/onSetAsScope=\{\(\) => graphFromHere\(fsPath, fsIsDir\)\}/);
  });

  test("the semantic inspector passes isDir from the selection kind", () => {
    expect(panel).toMatch(
      /graphFromHere\(\s*inspectorSelection\.path,\s*inspectorSelection\.kind === "directory",\s*\)/,
    );
  });
});

describe("depth slider holds its dragged value via a full-depth dir probe", () => {
  test("a dirDepthProbe state tracks the dir at full depth", () => {
    expect(panel).toMatch(/let dirDepthProbe: FsGraphResponse \| null = \$state\(null\);/);
    expect(panel).toMatch(/let dirDepthProbeLoading = \$state\(false\);/);
    expect(panel).toMatch(/let dirDepthProbePath: string \| null = \$state\(null\);/);
  });

  test("depthCap prefers the full-depth dir probe and never caps below the loaded depth", () => {
    // The cap uses the deep probe so dragging to 2/3 is not clamped back
    // to 1. Math.max with graphState.depth prevents snapping below what
    // is on screen before the probe lands.
    expect(panel).toMatch(/if \(filesystemMode && currentScope\?\.kind === "dir"\) \{/);
    expect(panel).toMatch(
      /fsGraph: dirDepthProbe \?\? \{ nodes: fsNodes, truncated: fsTruncated \},/,
    );
    expect(panel).toMatch(/return Math\.max\(probeCap, graphState\.depth\);/);
  });
});
