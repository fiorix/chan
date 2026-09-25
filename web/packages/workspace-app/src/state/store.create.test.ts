import { describe, expect, test } from "vitest";
import tabs from "./tabs.svelte.ts?raw";
import store from "./store.svelte.ts?raw";

// `new-file-and-draft-spec.md` item 2: after a successful create, an
// EDITABLE file opens in the Hybrid Editor (markdown rendered, other
// editable/source in source mode), and a DIRECTORY gets selected in
// the tree. The behaviour already lands on `main` through the unified
// create helpers + `defaultModeForPath`; these checks pin the
// load-bearing contract so a refactor can't silently regress the
// open-mode split or drop the open/select at the create-resolution
// layer.
//
// Empirically verified on a fresh binary (scoped test workspace,
// 2026-05-26): `.md` opens wysiwyg, `.txt` opens wysiwyg (it is
// markdown-class app-wide), `build.sh` opens source mode, and a
// `subdir/` create reveals + selects the dir while staying in the
// File Browser.

describe("item 2: create-resolution open/select", () => {
  test("createFile opens the new editable file in the active pane", () => {
    expect(store).toMatch(
      /async createFile\(parentPath: string\): Promise<void> \{[\s\S]{1,1500}await api\.create\(path, false, ""\);[\s\S]{1,400}await openInActivePane\(path, \{ landAtTop: true \}\);/,
    );
  });

  test("createDir reveals + selects the new directory in the tree", () => {
    expect(store).toMatch(
      /async createDir\(parentPath: string\): Promise<void> \{[\s\S]{1,1200}await api\.create\(path, true\);[\s\S]{1,400}revealAndSelect\(path\);/,
    );
  });

  test("createFileOrDir splits dir (reveal) vs file (open) on the resolved path", () => {
    expect(store).toMatch(
      /async createFileOrDir[\s\S]{1,2000}const isDir = next\.endsWith\("\/"\);[\s\S]{1,400}revealAndSelect\(next\);/,
    );
    expect(store).toMatch(
      /async createFileOrDir[\s\S]{1,3000}await openInActivePane\(path, \{ landAtTop: true \}\);/,
    );
  });
});

describe("item 2: defaultModeForPath open-mode split", () => {
  test("markdown-class (document) files default to wysiwyg, text-kind to source", () => {
    // The create flow reuses openInActivePane -> openInPane ->
    // defaultModeForPath, the same path every other open uses. The
    // mode split is: json -> pretty, csv -> table, text-kind ->
    // source, everything else (document) -> wysiwyg. A new `.md`
    // lands document -> wysiwyg (rendered); a `.sh` lands text ->
    // source (source-code mode), per the spec.
    expect(tabs).toMatch(
      /function defaultModeForPath\(path: string, fileKind: FileKind\): Mode \{[\s\S]{1,200}return fileKind === "text" \? "source" : "wysiwyg";/,
    );
  });

  test("openInPane peeks content for non-extension-editable files, never gates on writability", () => {
    // "Open even if read-only": the open path never consults the
    // fs-writable flag, so a read-only file still opens. The hard
    // extension gate is gone: an editable-by-extension file opens
    // straight away, and any other file is peeked (the server's content
    // gate decides) and refused only when it is binary.
    expect(tabs).toMatch(
      /export async function openInPane\([\s\S]{1,900}if \(!isEditableText\(path\) && \(await probeOpenableAsText\(path\)\) === "binary"\) \{/,
    );
    // The peek maps a 415 (the server's binary refusal) to "binary".
    expect(tabs).toMatch(/probeOpenableAsText[\s\S]{1,1400}status === 415\) return "binary"/);
  });
});
