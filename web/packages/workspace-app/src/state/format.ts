// Small formatting and path helpers with one definition each, so a size,
// a time or a path segment reads the same on every surface that shows it.

/** Human-friendly byte size (B / KB / MB / GB). One decimal at all
 *  scales above bytes; bytes are rendered as integers. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Relative time for an mtime (Unix epoch seconds). Falls back to an
 *  ISO date for anything older than a week so old files don't read
 *  as "365d ago". */
export function formatMtime(seconds: number | null): string {
  if (!seconds) return "(unknown)";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Last path segment, with both `/` and `\` accepted as separators. */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/// Workspace-relative parent directory of `path`. Returns "" for paths
/// at the workspace root (no parent) and for the empty string. Directories
/// follow the same rule as files; the caller decides whether to
/// treat the empty parent as "workspace scope" or skip.
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
