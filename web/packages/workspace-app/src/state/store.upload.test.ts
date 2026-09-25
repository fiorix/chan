// @vitest-environment jsdom
//
// Uploading goes through the transfer bubble: one row per upload (or per
// replaced file), its progress fed by the request's upload progress, a Cancel
// that aborts the request, and the tree refreshed with what landed. A name
// that already exists fails before anything is sent. The status bar carries
// only a launcher for the bubble. The client uploads with XMLHttpRequest, the
// one browser request that reports upload progress.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import { setXhrFactory } from "../api/transport";
import AppStatusBar from "../components/AppStatusBar.svelte";
import { demoData } from "../__tests__/app";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { fileOps, loadTreeDir, tree, ui } from "./store.svelte";
import { transfers } from "./transfers.svelte";

beforeEach(async () => {
  installDemoWorkspace(
    demoData([
      { path: "a.md", kind: "document", size: 8, mtime: 100, content: "old body" },
      { path: "docs/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  tree.entries = [];
  tree.loadedDirs = {};
  await loadTreeDir("");
  await loadTreeDir("docs");
});

afterEach(() => {
  uninstallDemoWorkspace();
  transfers.items = [];
  transfers.shown = false;
  ui.status = null;
});

/// An upload request that stays open until the test finishes it, recording
/// what the client sent.
class HeldXhr {
  static last: HeldXhr | null = null;
  method = "";
  url = "";
  body: FormData | null = null;
  aborted = false;
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  constructor() {
    HeldXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(): void {}
  getResponseHeader(): string | null {
    return null;
  }
  send(body: FormData): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  finish(path: string, size: number): void {
    this.status = 200;
    this.responseText = JSON.stringify({ path, size });
    this.onload?.();
    this.onloadend?.();
  }
}

function holdUploads(): void {
  HeldXhr.last = null;
  setXhrFactory(() => new HeldXhr() as unknown as XMLHttpRequest);
}

describe("uploading into a folder", () => {
  test("lands the file, refreshes the tree and finishes the bubble's row", async () => {
    await fileOps.uploadFilesTo("docs", [new File(["fresh"], "c.md")]);

    await expect(api.read("docs/c.md")).resolves.toMatchObject({ content: "fresh" });
    expect(tree.entries.map((entry) => entry.path)).toContain("docs/c.md");
    expect(transfers.items).toMatchObject([{ kind: "upload", filename: "c.md", state: "done" }]);
    expect(ui.status).toBe("Uploaded 'docs/c.md'");
  });

  test("feeds the request's upload progress into the bubble", async () => {
    holdUploads();
    const upload = fileOps.uploadFilesTo("docs", [new File(["0123456789"], "c.md")]);
    await vi.waitFor(() => expect(HeldXhr.last?.body).toBeTruthy());

    HeldXhr.last!.progress(5, 10);
    // The bubble coalesces progress renders, so the half mark lands within one
    // coalescing window.
    await vi.waitFor(() => expect(transfers.items[0].progress).toBe(0.5));

    HeldXhr.last!.finish("docs/c.md", 10);
    await upload;
    expect(transfers.items[0]).toMatchObject({ state: "done", progress: 1 });
  });

  test("Cancel in the bubble aborts the request", async () => {
    holdUploads();
    const upload = fileOps.uploadFilesTo("docs", [new File(["0123456789"], "c.md")]);
    await vi.waitFor(() => expect(HeldXhr.last?.body).toBeTruthy());

    transfers.items[0].cancel!();
    await upload;

    expect(HeldXhr.last!.aborted).toBe(true);
    expect(transfers.items[0].state).toBe("cancelled");
    expect(ui.status).toBe("Upload cancelled");
  });

  test("refuses a name that already exists, before sending anything", async () => {
    const upload = vi.spyOn(api, "uploadFile");

    await fileOps.uploadFilesTo("docs", [new File(["dup"], "b.md")]);

    expect(ui.status).toBe("upload failed: 'docs/b.md' already exists");
    expect(upload).not.toHaveBeenCalled();
    expect(transfers.items).toEqual([]);
  });
});

describe("replacing a file", () => {
  test("goes through the bubble under the replaced file's name", async () => {
    await fileOps.replaceFileAt("a.md", new File(["new body"], "other.md"));

    expect(transfers.items).toMatchObject([{ kind: "upload", filename: "a.md", state: "done" }]);
  });
});

describe("api.uploadFile", () => {
  test("posts the folder and the file to /api/fs/upload", async () => {
    holdUploads();
    const file = new File(["fresh"], "c.md");
    const sent = api.uploadFile(file, "docs");

    const xhr = HeldXhr.last!;
    expect(xhr.method).toBe("POST");
    expect(new URL(xhr.url, "http://x").pathname).toBe("/api/fs/upload");
    expect(xhr.body?.get("dir")).toBe("docs");
    expect(xhr.body?.get("file")).toBe(file);
    xhr.finish("docs/c.md", 5);
    await expect(sent).resolves.toEqual({ path: "docs/c.md", size: 5 });
  });

  test("aborts the request when its signal fires", async () => {
    holdUploads();
    const abort = new AbortController();
    const sent = api.uploadFile(new File(["fresh"], "c.md"), "docs", { signal: abort.signal });

    abort.abort();

    await expect(sent).rejects.toMatchObject({ name: "AbortError" });
    expect(HeldXhr.last!.aborted).toBe(true);
  });
});

describe("the status bar", () => {
  test("offers a Transfers launcher counting the rows, which opens the bubble", async () => {
    holdUploads();
    void fileOps.uploadFilesTo("docs", [new File(["fresh"], "c.md")]);
    await vi.waitFor(() => expect(transfers.items).toHaveLength(1));
    const target = document.createElement("div");
    document.body.append(target);
    const view = mount(AppStatusBar, { target });
    try {
      flushSync();
      const launcher = target.querySelector<HTMLButtonElement>('[aria-label="show file transfers"]')!;
      expect(launcher.textContent?.replace(/\s+/g, " ").trim()).toBe("⇅ Transfers (1)");
      expect(target.textContent).not.toContain("uploading");

      launcher.click();
      expect(transfers.shown).toBe(true);
    } finally {
      unmount(view);
      target.remove();
      HeldXhr.last?.abort();
    }
  });
});
