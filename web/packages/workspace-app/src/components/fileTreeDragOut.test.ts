import { describe, expect, test } from "vitest";
import client from "../api/client.ts?raw";
import fileTree from "./FileTree.svelte?raw";
import fileInfo from "./FileInfoBody.svelte?raw";
import store from "../state/store.svelte.ts?raw";

// Native file drag-out is removed (macOS drag-out crashed). Export
// and import now use the Download and Upload buttons. These tests assert
// the drag-out payloads and the native Tauri command are gone, while
// the app-internal tree-move drag and the transfer buttons stay.
describe("FileTree browser drag-out removed", () => {
  test("api still exposes token-bearing download URLs (for the Download button)", () => {
    expect(client).toMatch(/downloadUrl: \(path: string\) =>/);
    expect(client).toMatch(
      /withTokenQuery\(`\/api\/files\/\$\{encPath\(path\)\}\?download=1`\)/,
    );
  });

  test("file drags no longer carry DownloadURL / uri-list drag-out payloads", () => {
    expect(fileTree).not.toMatch(/setData\(\s*"DownloadURL"/);
    expect(fileTree).not.toMatch(/setData\("text\/uri-list"/);
    // The drag-out helpers are gone entirely.
    expect(fileTree).not.toContain("setDownloadDragData");
    expect(fileTree).not.toContain("function downloadMime");
    expect(fileTree).not.toContain("absoluteDownloadUrl");
  });

  test("dragstart keeps the app-internal tree-move + editor-open payloads only", () => {
    expect(fileTree).toMatch(/e\.dataTransfer\.effectAllowed = "move"/);
    expect(fileTree).toMatch(/e\.dataTransfer\.setData\(TREE_MOVE_MIME, payload\)/);
    expect(fileTree).toMatch(/e\.dataTransfer\.setData\(FILE_DRAG_MIME/);
    expect(fileTree).not.toContain("setDownloadDragData(e, path, isDir)");
  });

  test("the native Tauri drag-out command + its desktop import are gone", () => {
    expect(fileTree).not.toContain("start_file_browser_drag_out");
    expect(fileTree).not.toContain("startNativeDragOut");
    expect(fileTree).not.toMatch(/from "\.\.\/api\/desktop"/);
  });

  test("selection context menu keeps Upload and Download transfer rows", () => {
    // Transfer rows come from the shared classifier (the same
    // applicability the inspector consumes) and are
    // variant-independent; the handlers are the tree-local download
    // link + upload picker.
    expect(fileTree).toMatch(/label: "Upload",[\s\S]{1,160}onClick: \(\) => uploadSelection\(path, isDir\)/);
    expect(fileTree).toMatch(/label: "Download",[\s\S]{1,160}onClick: \(\) => downloadSelection\(path, isDir\)/);
    expect(fileTree).not.toMatch(/\{#if docked\}/);
    expect(fileTree).toMatch(/function downloadSelection\(path: string, isDir: boolean\): void/);
    expect(fileTree).toMatch(/link\.href = api\.downloadUrl\(path\)/);
  });

  test("shared inspectors expose Upload and Download transfer actions", () => {
    // Upload + Download live in the shared actionsSection's pill/dropdown
    // model; download progress shows in the transfer bubble (the single
    // download surface).
    expect(fileInfo).toMatch(/onClick: triggerUpload/);
    expect(fileInfo).toMatch(/onClick: downloadSelection/);
    expect(fileInfo).toMatch(/fileOps\.replaceFileAt\(entry\.path, files\[0\]!\)/);
    expect(fileInfo).toMatch(/fileOps\.uploadFilesTo\(entry\.path, files\)/);
    // The folder inspector uses FileInfoBody's dir branch, not a
    // separate DirectoryInfoBody component.
    expect(fileInfo).toMatch(/fileOps\.uploadFilesTo\(entry\.path, files\)/);
  });

  test("file replacement uses upload replace mode and refreshes open tabs", () => {
    expect(client).toMatch(/replaceFile: \(/);
    expect(client).toMatch(/form\.append\("path", path\)/);
    expect(fileTree).toMatch(/fileOps\.replaceFileAt\(target\.path, input\.files\[0\]!\)/);
    expect(fileTree).toMatch(/fileOps\.uploadFilesTo\(target\.path, input\.files\)/);
    expect(store).toMatch(/replaceFileAt\(targetPath: string, picked: File\)/);
    expect(store).toMatch(/api\.replaceFile\(picked, targetPath/);
    expect(store).toMatch(/tabsForPath\(targetPath\)/);
    expect(store).toMatch(/refreshTabFromDisk\(tab\.tabId\)/);
  });
});
