// The demo's drafts. The server keeps a workspace's drafts outside the
// workspace, one directory per draft with the id of that draft's lifetime,
// and names a draft's file by its root, its path and that id. The demo does
// the same in memory: a store of its own, so no draft is an entry of the
// workspace tree, and a request that names a lifetime that ended is answered
// as stale.

import type { FileIdentity } from "../api/fileIdentity";
import type {
  DraftInspectResponse,
  DraftPromoteResponse,
  FileResponse,
  FileWriteResponse,
} from "../api/types";
import type { MockWorkspaceData } from "./data";
import { kindForPath, MockWorkspaceStore } from "./store";

/// Where the demo says its drafts are on the server's machine.
const DRAFT_STORE_ROOT = "/home/demo/.chan/workspaces/demo/Drafts";

const NUL = String.fromCharCode(0);

/// A draft request the demo refuses, with the status and body the server
/// answers it with.
export class DemoDraftRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; code?: string; name?: string },
  ) {
    super(body.error);
  }
}

type DraftIdentity = FileIdentity & { root: "draft"; draft_id: string };

export type DemoDraftRow = {
  name: string;
  primary: DraftIdentity;
  has_attachments: boolean;
  busy: boolean;
};

export type DemoPromotion = {
  answer: DraftPromoteResponse & { primary: FileIdentity; target: string };
  /// The workspace files the promotion wrote.
  written: string[];
};

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/// A file name without its extension. A leading dot starts none.
function stemOf(leaf: string): string {
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

export class DemoDrafts {
  /// The files of every draft: each top-level directory is one draft.
  readonly store: MockWorkspaceStore;
  #lifetimes = new Map<string, string>();
  #seq = 0;

  constructor(data: MockWorkspaceData) {
    this.store = new MockWorkspaceStore({ ...data, files: [] });
    for (const draft of data.drafts ?? []) {
      for (const [leaf, content] of Object.entries(draft.files)) {
        this.adopt({ path: `${draft.name}/${leaf}`, draft_id: draft.draft_id }, content);
      }
    }
  }

  /// Hold a draft's file as the server would after its draft was created:
  /// the draft's lifetime is live under the id given. For a fixture that
  /// starts from a draft the demo did not mint.
  adopt(identity: { path: string; draft_id?: string }, content: string): FileWriteResponse {
    this.#lifetimes.set(identity.path.split("/")[0] ?? "", identity.draft_id ?? "");
    return this.store.write(identity.path, content);
  }

  /// A new draft seeded with one primary file, under the next free name.
  create(leaf = "draft.md", content = ""): { path: string; name: string; primary: DraftIdentity } {
    do {
      this.#seq += 1;
    } while (this.#lifetimes.has(`untitled-${this.#seq}`));
    const name = `untitled-${this.#seq}`;
    const draftId = `demo-life-${this.#seq}`;
    const path = `${name}/${leaf}`;
    this.#lifetimes.set(name, draftId);
    this.store.create(path, false, content);
    return { path, name, primary: { root: "draft", path, draft_id: draftId } };
  }

  list(): DemoDraftRow[] {
    const rows: DemoDraftRow[] = [];
    for (const [name, draftId] of this.#lifetimes) {
      const files = this.#files(name);
      const primary = this.#primary(name);
      if (primary === null) continue;
      rows.push({
        name,
        primary: { root: "draft", path: primary, draft_id: draftId },
        has_attachments: files.length > 1,
        busy: false,
      });
    }
    return rows;
  }

  /// The name of the live draft that `path` and `draftId` name. Refuses a
  /// path no file system could hold, and a lifetime that ended or whose name
  /// was taken by a later draft.
  pin(path: string, draftId: string | null | undefined): string {
    if (path.includes(NUL)) {
      throw new DemoDraftRefusal(400, { error: "invalid path" });
    }
    const name = path.split("/")[0] ?? "";
    if (name === "" || !draftId || this.#lifetimes.get(name) !== draftId) {
      throw new DemoDraftRefusal(409, {
        error: `draft \`${name}\` session closed, is closing, or its name was reused; refetch its identity`,
        code: "draft_stale",
        name,
      });
    }
    return name;
  }

  read(path: string, draftId: string | null): FileResponse | null {
    this.pin(path, draftId);
    return this.store.read(path);
  }

  write(path: string, draftId: string | null, content: string): FileWriteResponse {
    this.pin(path, draftId);
    return this.store.write(path, content);
  }

  inspect(source: FileIdentity): DraftInspectResponse & { primary: DraftIdentity } {
    const name = this.pin(source.path, source.draft_id);
    const files = this.#files(name);
    const primary = this.#primary(name) ?? source.path;
    return {
      path: primary,
      name,
      file_count: files.length,
      dir_count: 0,
      total_size: files.reduce((sum, path) => sum + (this.store.get(path)?.size ?? 0), 0),
      has_attachments: files.length > 1,
      primary: { root: "draft", path: primary, draft_id: source.draft_id ?? "" },
    };
  }

  discard(source: FileIdentity): void {
    const name = this.pin(source.path, source.draft_id);
    this.store.remove(name);
    this.#lifetimes.delete(name);
  }

  /// Move a draft into `workspace` and end its lifetime. `target` is a file
  /// path the caller chose. A draft that is one file becomes that file. A
  /// draft with more goes whole into the folder named after the chosen
  /// file's stem, new or already there, each file under its own name; the
  /// chosen path must then be an editable text file's and name nothing yet.
  /// Nothing is overwritten: an occupied destination refuses and the draft
  /// stays.
  promote(source: FileIdentity, target: string, workspace: MockWorkspaceStore): DemoPromotion {
    const name = this.pin(source.path, source.draft_id);
    const files = this.#files(name);
    const primary = this.#primary(name);
    if (primary === null) {
      throw new DemoDraftRefusal(400, { error: `draft \`${name}\` has no primary file` });
    }
    const lone = files.length === 1;
    const occupied = (path: string) => workspace.get(path) !== undefined || workspace.isDir(path);
    if (!lone) {
      const kind = target.endsWith("/") ? null : kindForPath(target);
      if (!leafOf(target).includes(".") || (kind !== "document" && kind !== "text")) {
        throw new DemoDraftRefusal(400, { error: `not an editable text file: ${target}` });
      }
      if (occupied(target)) {
        throw new DemoDraftRefusal(409, { error: `path already exists: ${target}` });
      }
    }
    const dir = target.slice(0, target.length - leafOf(target).length) + stemOf(leafOf(target));
    const merged = !lone && workspace.isDir(dir);
    const moves = files.map((from) => ({
      from,
      to: lone ? target : `${dir}/${from.slice(name.length + 1)}`,
    }));
    // A lone draft needs a free name. A whole draft needs its folder not
    // to be a file, and each of its own names free inside it.
    const taken = lone
      ? [target].find(occupied)
      : workspace.get(dir) !== undefined
        ? dir
        : moves.map(({ to }) => to).find(occupied);
    if (taken !== undefined) {
      throw new DemoDraftRefusal(409, { error: `path already exists: ${taken}` });
    }
    for (const { from, to } of moves) {
      const entry = this.store.get(from)!;
      workspace.upload(to, { size: entry.size, kind: entry.kind, content: entry.content });
    }
    this.store.remove(name);
    this.#lifetimes.delete(name);
    const promotedPrimary = moves.find(({ from }) => from === primary)!.to;
    return {
      answer: {
        path: promotedPrimary,
        name,
        mode: lone ? "file" : merged ? "directory_merged" : "directory_created",
        primary: { root: "workspace", path: promotedPrimary },
        target: lone ? target : dir,
      },
      written: moves.map(({ to }) => to),
    };
  }

  /// The path of a draft's file on the server's machine, for a terminal.
  terminalPath(source: FileIdentity): string {
    if (source.root !== "draft") {
      throw new DemoDraftRefusal(400, { error: "not a draft file" });
    }
    this.pin(source.path, source.draft_id);
    if (this.store.get(source.path) === undefined) {
      throw new DemoDraftRefusal(400, { error: `no such draft file: ${source.path}` });
    }
    return `${DRAFT_STORE_ROOT}/${source.path}`;
  }

  #files(name: string): string[] {
    const prefix = `${name}/`;
    return this.store
      .entries()
      .map((entry) => entry.path)
      .filter((path) => path.startsWith(prefix));
  }

  /// A draft's primary: its `draft.md`, else its drawing, else its first
  /// file.
  #primary(name: string): string | null {
    const top = this.#files(name).filter((path) => !path.slice(name.length + 1).includes("/"));
    return (
      top.find((path) => leafOf(path) === "draft.md") ??
      top.find((path) => path.endsWith(".excalidraw")) ??
      top[0] ??
      null
    );
  }
}
