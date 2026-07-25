// In-memory workspace filesystem for the frontend-only demo. Loads the git
// snapshot into maps and serves the file/tree/session surfaces the real
// backend would. Every mutation (write/create/remove/move) stays in memory:
// nothing is persisted and nothing is downloaded.

import type {
  FileResponse,
  FileWriteResponse,
  InspectorKind,
  InspectorPayload,
  MoveResponse,
  TreeEntry,
} from "../api/types";
import type { MockFileEntry, MockWorkspaceData } from "./data";

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function mtimeNs(seconds: number | null): string | null {
  return seconds == null ? null : `${seconds}000000000`;
}

type DirBucket = { dirs: Set<string>; files: Set<string> };

export class MockWorkspaceStore {
  readonly data: MockWorkspaceData;
  #files = new Map<string, MockFileEntry>();
  #children = new Map<string, DirBucket>();
  #dirs = new Set<string>();
  #sessions = new Map<string, unknown>();

  constructor(data: MockWorkspaceData) {
    this.data = data;
    for (const entry of data.files) this.#files.set(entry.path, { ...entry });
    this.#reindex();
  }

  // Rebuild the directory index from the flat file map. Cheap enough (~1k
  // entries) to run on every mutation, which keeps listing logic simple and
  // always correct without fiddly incremental bookkeeping.
  #reindex(): void {
    this.#children = new Map();
    this.#dirs = new Set();
    const bucket = (dir: string): DirBucket => {
      let b = this.#children.get(dir);
      if (!b) {
        b = { dirs: new Set(), files: new Set() };
        this.#children.set(dir, b);
      }
      return b;
    };
    for (const path of this.#files.keys()) {
      bucket(parentOf(path)).files.add(path);
      let dir = parentOf(path);
      while (dir !== "") {
        this.#dirs.add(dir);
        bucket(parentOf(dir)).dirs.add(dir);
        dir = parentOf(dir);
      }
    }
  }

  isDir(path: string): boolean {
    return path === "" || this.#dirs.has(path);
  }

  list(dir: string): TreeEntry[] {
    const b = this.#children.get(dir);
    const entries: TreeEntry[] = [];
    if (b) {
      for (const d of b.dirs) {
        entries.push({ path: d, is_dir: true, mtime: null, size: 0 });
      }
      for (const f of b.files) {
        const e = this.#files.get(f)!;
        entries.push({
          path: f,
          is_dir: false,
          mtime: e.mtime,
          size: e.size,
          kind: e.kind ?? "text",
        });
      }
    }
    entries.sort((a, z) => {
      if (a.is_dir !== z.is_dir) return a.is_dir ? -1 : 1;
      return baseName(a.path).localeCompare(baseName(z.path));
    });
    return entries;
  }

  read(path: string): FileResponse | null {
    const e = this.#files.get(path);
    if (!e) return null;
    return {
      path,
      content: e.content ?? "",
      mtime: e.mtime,
      mtime_ns: mtimeNs(e.mtime),
      authority_version: null,
      disk_conflicted: false,
      writable: true,
    };
  }

  write(path: string, content: string): FileWriteResponse {
    const mtime = nowSeconds();
    const existing = this.#files.get(path);
    const entry: MockFileEntry = {
      path,
      kind: existing?.kind ?? kindForPath(path),
      size: content.length,
      mtime,
      content,
    };
    const isNew = !existing;
    this.#files.set(path, entry);
    if (isNew) this.#reindex();
    return {
      mtime,
      mtime_ns: mtimeNs(mtime),
      authority_version: null,
      disk_conflicted: false,
    };
  }

  /// Write an uploaded file into memory. Unlike `write`, the byte size is
  /// explicit (media/binary carry no text content, so size can't be derived
  /// from a string length).
  upload(path: string, opts: { size: number; kind: MockFileEntry["kind"]; content?: string }): void {
    const isNew = !this.#files.has(path);
    this.#files.set(path, {
      path,
      kind: opts.kind,
      size: opts.size,
      mtime: nowSeconds(),
      content: opts.content,
    });
    if (isNew) this.#reindex();
  }

  create(path: string, isDir: boolean, content?: string): void {
    if (isDir) {
      // Directories are implicit in the index; seed an empty bucket so an
      // empty new folder still lists (until it gets a child).
      this.#dirs.add(path);
      if (!this.#children.has(path)) {
        this.#children.set(path, { dirs: new Set(), files: new Set() });
      }
      const b = this.#children.get(parentOf(path));
      if (b) b.dirs.add(path);
      return;
    }
    this.#files.set(path, {
      path,
      kind: kindForPath(path),
      size: content?.length ?? 0,
      mtime: nowSeconds(),
      content: content ?? "",
    });
    this.#reindex();
  }

  remove(path: string): void {
    if (this.#files.has(path)) {
      this.#files.delete(path);
    } else {
      // Directory: drop every descendant file.
      const prefix = `${path}/`;
      for (const p of [...this.#files.keys()]) {
        if (p.startsWith(prefix)) this.#files.delete(p);
      }
    }
    this.#reindex();
  }

  move(from: string, to: string): MoveResponse {
    const renamed: Array<[string, string]> = [];
    if (this.#files.has(from)) {
      const e = this.#files.get(from)!;
      this.#files.delete(from);
      this.#files.set(to, { ...e, path: to, mtime: nowSeconds() });
      renamed.push([from, to]);
    } else {
      const prefix = `${from}/`;
      for (const p of [...this.#files.keys()]) {
        if (!p.startsWith(prefix)) continue;
        const np = `${to}/${p.slice(prefix.length)}`;
        const e = this.#files.get(p)!;
        this.#files.delete(p);
        this.#files.set(np, { ...e, path: np });
        renamed.push([p, np]);
      }
    }
    this.#reindex();
    return { renamed, rewritten: [], conflicts: [] };
  }

  // --- session (per-window layout) ---
  getSession(windowId: string): unknown | null {
    return this.#sessions.has(windowId) ? this.#sessions.get(windowId) : null;
  }
  putSession(windowId: string, payload: unknown): void {
    this.#sessions.set(windowId, payload);
  }
  deleteSession(windowId: string): void {
    this.#sessions.delete(windowId);
  }

  inspector(path: string): InspectorPayload {
    const dir = this.isDir(path);
    const e = this.#files.get(path);
    return {
      path,
      kind: inspectorKind(dir, e?.kind),
      is_dir: dir,
      size: e?.size ?? 0,
      mtime: e?.mtime ?? null,
      path_class: {
        kind: dir ? "directory" : "regular_file",
        permission: "read_write",
        link_count: 1,
      },
      frontmatter_kind: null,
      report_file: null,
      report_summary: null,
      subtree: null,
    };
  }

  // --- read access for graph/headings/search phases ---
  entries(): MockFileEntry[] {
    return [...this.#files.values()];
  }
  get(path: string): MockFileEntry | undefined {
    return this.#files.get(path);
  }
}

// Classify a path the way the snapshot does, for files created at runtime
// (drafts, new notes). Only the coarse editable-vs-media split matters here.
const MEDIA_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
]);
export function kindForPath(path: string): MockFileEntry["kind"] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "document";
  if (MEDIA_EXTS.has(ext)) return "media";
  return "text";
}

function inspectorKind(isDir: boolean, kind?: MockFileEntry["kind"]): InspectorKind {
  if (isDir) return "directory";
  switch (kind) {
    case "document":
    case "contact":
      return "markdown";
    case "media":
      return "media";
    case "binary":
      return "binary";
    default:
      return "text";
  }
}
