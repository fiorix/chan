// Uploads for the test transport. Multipart uploads (the file browser
// inspector's upload/replace, editor image paste) normally POST to the server;
// here they land in the in-memory store instead, so an uploaded file shows up
// in the tree and opens like any other.
//
// File uploads (uploadFile/replaceFile) use XMLHttpRequest for progress, which
// the fetch seam does not cover, so the mock swaps in the XHR below.
// Attachment uploads use fetch and are routed by the mock router; both share
// applyUpload.

import type { DemoGraph } from "./graph";
import { kindForPath, type MockWorkspaceStore } from "./store";

/// Write one multipart upload into the store. `path` (replace) wins; otherwise
/// the file lands under `dir` (or `defaultDir`) by its name. Text files keep
/// their content in memory; media keeps only its byte size. Returns the wire
/// `{ path, size }` the upload callers expect.
export async function applyUpload(
  store: MockWorkspaceStore,
  graph: DemoGraph,
  form: FormData,
  defaultDir = "",
): Promise<{ path: string; size: number }> {
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new Error("upload: missing file");
  const name = file instanceof File ? file.name : "upload";

  const explicitPath = form.get("path");
  let target: string;
  if (typeof explicitPath === "string" && explicitPath) {
    target = explicitPath;
  } else {
    const dirValue = form.get("dir");
    const dir = typeof dirValue === "string" && dirValue ? dirValue : defaultDir;
    target = dir ? `${dir}/${name}` : name;
  }

  const kind = kindForPath(target);
  const isText = kind === "document" || kind === "text";
  const content = isText ? await file.text() : undefined;
  store.upload(target, { size: file.size, kind, content });
  if (kind === "document") graph.indexFile(target, content ?? "");
  return { path: target, size: file.size };
}

// Minimal XMLHttpRequest stand-in: only the surface the upload helpers touch
// (open / setRequestHeader / upload.onprogress / onload / onerror / onabort /
// onloadend / status / statusText / responseText / abort / send). Instant, in
// memory. Cast to XMLHttpRequest at the factory boundary.
class DemoUploadXhr {
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((ev: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  #aborted = false;

  constructor(
    private store: MockWorkspaceStore,
    private graph: DemoGraph,
  ) {}

  open(_method: string, _url: string): void {}
  setRequestHeader(): void {}

  abort(): void {
    this.#aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }

  send(form: FormData): void {
    void Promise.resolve().then(async () => {
      if (this.#aborted) return;
      try {
        const result = await applyUpload(this.store, this.graph, form);
        if (this.#aborted) return;
        const file = form.get("file");
        const size = file instanceof Blob ? file.size : 0;
        this.upload.onprogress?.({ loaded: size, total: size, lengthComputable: true });
        this.status = 200;
        this.statusText = "OK";
        this.responseText = JSON.stringify(result);
        this.onload?.();
      } catch (err) {
        if (this.#aborted) return;
        this.status = 500;
        this.statusText = "error";
        this.responseText = (err as Error).message;
        this.onerror?.();
      } finally {
        if (!this.#aborted) this.onloadend?.();
      }
    });
  }
}

export function createDemoUploadXhr(store: MockWorkspaceStore, graph: DemoGraph): XMLHttpRequest {
  return new DemoUploadXhr(store, graph) as unknown as XMLHttpRequest;
}
