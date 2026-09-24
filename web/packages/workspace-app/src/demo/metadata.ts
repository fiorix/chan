// Metadata export/import for the test transport. The real feature ships a
// workspace's derived metadata as a tar.zst; here there is no server and no
// separate metadata store, so export serializes the in-memory workspace (its
// text files, including live edits) to a small JSON archive the browser
// downloads, and import reads that archive back into the in-memory store. The
// round-trip is self-contained: export from one mock session, import into
// another.

import type { DemoGraph } from "./graph";
import type { MockWorkspaceStore } from "./store";
import type { MetadataImportReport } from "../api/types";

const ARCHIVE_FORMAT = "chan-demo-metadata";
const ARCHIVE_VERSION = 1;

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".markdown");
}

/// Serialize the in-memory workspace's text files (with current edits) to the
/// mock archive body, plus the counts the export headers carry.
export function exportMetadata(store: MockWorkspaceStore): {
  body: string;
  files: number;
  bytes: number;
  filename: string;
} {
  const files = store
    .entries()
    .filter((e) => e.content !== undefined)
    .map((e) => ({ path: e.path, content: e.content as string }));
  const bytes = files.reduce((n, f) => n + f.content.length, 0);
  const body = JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, files });
  return { body, files: files.length, bytes, filename: `${store.data.metadata.label}-metadata.json` };
}

/// Apply a mock archive to the in-memory store (create/overwrite each file) and
/// return the report the import UI renders. An archive in another format
/// imports zero files rather than throwing, so the UI still shows a (empty)
/// success report.
export function importMetadata(
  store: MockWorkspaceStore,
  graph: DemoGraph,
  text: string,
  opts: { rescan: boolean },
): MetadataImportReport {
  let parsed: { format?: string; files?: unknown } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const rows =
    parsed?.format === ARCHIVE_FORMAT && Array.isArray(parsed.files)
      ? (parsed.files as Array<{ path?: unknown; content?: unknown }>)
      : [];

  const imported: string[] = [];
  let bytes = 0;
  for (const f of rows) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") continue;
    store.write(f.path, f.content);
    if (isMarkdown(f.path)) graph.indexFile(f.path, f.content);
    imported.push(f.path);
    bytes += f.content.length;
  }

  const label = store.data.metadata.label;
  return {
    manifest: {
      archive_format_version: ARCHIVE_VERSION,
      chan_version: "demo",
      created_at: new Date().toISOString(),
      source_root: label,
      source_metadata_key: "demo",
      metadata_schema: { path_key_scheme: "demo", index_schema_version: 1 },
      included_subtrees: imported.length > 0 ? [""] : [],
      excluded_subtrees: [],
    },
    imported_subtrees: imported,
    files: imported.length,
    bytes,
    rescanned: opts.rescan,
  };
}
