import { describe, expect, test } from "vitest";
import fileEditorTab from "./FileEditorTab.svelte?raw";
import fileTree from "./FileTree.svelte?raw";
import fileBrowserSurface from "./FileBrowserSurface.svelte?raw";
import store from "../state/store.svelte.ts?raw";

// An explicit open must re-place the caret of a kept-alive tab whose
// editor has latched its one-shot `initialCaret`. The channel is:
//   explicit-open caller -> openInPane (landAtTop / initialSelection)
//     -> issueCaretCommand sets tab.caretCommand
//       -> FileEditorTab $effect -> editor.resetCaret().
// The editor's resetCaret mechanism and the openInPane->caretCommand step are
// proven behaviorally in newFileCaret.test.ts and tabs.test.ts; these guards
// lock the two source-only hops: the consumer effect and the caller intent.

describe("FileEditorTab consumes the caret command", () => {
  test("an $effect reads tab.caretCommand and calls the editor's resetCaret", () => {
    expect(fileEditorTab).toMatch(
      /const cmd = tab\.caretCommand;[\s\S]*?wysiwygRef\?\.resetCaret\(cmd\.from, cmd\.to\);[\s\S]*?sourceRef\?\.resetCaret\(cmd\.from, cmd\.to\);/,
    );
  });
});

describe("explicit-open callers force landAtTop", () => {
  test("FileTree double-click / Open button", () => {
    expect(fileTree).toMatch(/openInActivePane\(path, \{ landAtTop: true \}\)/);
  });

  test("File Browser open-selection", () => {
    expect(fileBrowserSurface).toMatch(
      /openInActivePane\(entry\.path, \{ landAtTop: true \}\)/,
    );
  });

  test("`cs open` window command", () => {
    expect(store).toMatch(
      /openInPane\(destination\.paneId, frame\.path, \{[\s\S]{1,120}landAtTop: true,[\s\S]{1,120}side: destination\.side,/,
    );
  });

  test("create + duplicate open at top", () => {
    // create / createFileOrDir both open the fresh path; duplicate opens target.
    expect(store).toMatch(/openInActivePane\(path, \{ landAtTop: true \}\)/);
    expect(store).toMatch(/openInActivePane\(target, \{ landAtTop: true \}\)/);
  });
});
