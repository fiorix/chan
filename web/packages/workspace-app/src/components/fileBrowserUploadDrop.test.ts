import { describe, expect, test } from "vitest";
import statusBar from "./AppStatusBar.svelte?raw";
import tree from "./FileTree.svelte?raw";
import client from "../api/client.ts?raw";
import store from "../state/store.svelte.ts?raw";

describe("File Browser upload via the Upload button", () => {
  // External OS file drops (drag-IN) are no longer accepted by the
  // tree; importing files is the Upload button's job. The drop
  // handlers only resolve the app-internal tree-move.
  test("FileTree no longer routes external file drops to upload", () => {
    expect(tree).not.toContain('types.includes("Files")');
    expect(tree).not.toContain("fileOps.uploadFilesTo(destDir, files)");
    expect(tree).not.toContain("hasExternalFiles");
    // The internal tree-move drop wiring stays on the rows.
    expect(tree).toContain("ondrop={(e) => onRowDrop(e, node.path)}");
    expect(tree).toContain("ondrop={(e) => onRowDrop(e, parentOf(node.path))}");
    // The Upload button still workspaces uploadFilesTo at the picked target.
    expect(tree).toContain("fileOps.uploadFilesTo(target.path");
  });

  test("store upload flow drives the transfer bubble with cancel + tree refresh", () => {
    // Both upload entry points (new upload + replace) route through the
    // transfer bubble now; the old fileTransferStatus status-bar slot is gone.
    expect(store).not.toContain("fileTransferStatus");
    expect(store).toContain("AbortController");
    expect(store).toContain("api.uploadFile(file, destDir");
    expect(store).toContain("await refreshTreeForPath(result.path)");
    expect(store).toContain("upload failed: '${target}' already exists");
    expect(store).toContain("beginTransfer({ kind: \"upload\"");
    expect(store).toContain("setTransferProgress(xferId");
    expect(store).toContain("finishTransfer(xferId)");
    // The single-upload-at-a-time guard reads the bubble's records.
    expect(store).toContain("waitForTransferSlot(xferId)");
  });

  test("replace upload also routes through the transfer bubble", () => {
    expect(store).toMatch(
      /replaceFileAt\(targetPath: string, picked: File\)[\s\S]*?beginTransfer\(\{\s*kind: "upload"/,
    );
  });

  test("api client uses XHR so upload progress can feed the transfer bubble", () => {
    // XHR is created through the transport seam (createXhr) so the demo can
    // swap in a mock; it is still an XMLHttpRequest on the production path.
    expect(client).toContain("createXhr()");
    expect(client).toContain("xhr.upload.onprogress");
    expect(client).toContain('/api/files/upload');
    expect(client).toContain("opts.signal?.addEventListener");
  });

  test("status bar retired the inline upload text; transfers launch from the bubble", () => {
    // The inline upload status section (with its own cancel ×) is gone;
    // progress + cancel now live in the transfer bubble (TransferBubble.svelte),
    // reachable from the status bar's transfers launcher.
    expect(statusBar).not.toContain("fileTransferStatus");
    expect(statusBar).not.toContain('aria-label="file transfer status"');
    expect(statusBar).not.toContain('aria-label="cancel upload"');
    expect(statusBar).toContain('aria-label="show file transfers"');
    expect(statusBar).toContain("⇅ Transfers (");
  });
});
