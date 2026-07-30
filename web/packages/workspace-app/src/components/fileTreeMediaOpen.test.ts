import { describe, expect, test } from "vitest";
import fileTree from "./FileTree.svelte?raw";

// The row gestures route through state/mediaOpen's shared viewer
// router (functionally covered in state/mediaOpen.test.ts); these pins
// hold the FileTree wiring: one funnel for double-click and Enter,
// media handled before the editor open attempt, and no media dead-gate
// left anywhere.
describe("FileTree media open wiring", () => {
  test("double-click and Enter share one media-first funnel", () => {
    expect(fileTree).toMatch(
      /function openFileRow\(path: string\): void \{\s*if \(openMediaViewer\(path\)\) return;\s*void onOpen\(path\);\s*\}/,
    );
    expect(fileTree).toMatch(/ondblclick=\{\(\) => openFileRow\(node\.path\)\}/);
    expect(fileTree).toMatch(/openFileRow\(curRow\.path\);/);
  });

  test("the media dead-gate is gone from both gesture sites", () => {
    // Media rows used to skip the dblclick bind and no-op on Enter via
    // a classifyPath gate; both gestures now bind for every file.
    expect(fileTree).not.toMatch(/classifyPath/);
    expect(fileTree).not.toMatch(/openable/);
  });
});
