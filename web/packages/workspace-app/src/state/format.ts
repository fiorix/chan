// Small formatting helpers (a byte size, a file time, a code report's
// COCOMO months, developers and cost) and path helpers (`parentDir`,
// `basename`), each defined once for the callers that share its rule.

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

/** A COCOMO estimate in months (effort in person-months, or schedule): a
 *  whole number from ten up, one decimal below. " - " when the estimate is
 *  not a finite number. */
export function fmtMonths(n: number): string {
  if (!Number.isFinite(n)) return " - ";
  return n >= 10 ? `${Math.round(n)} mo` : `${n.toFixed(1)} mo`;
}

/** A COCOMO developer count, rounded as `fmtMonths` rounds. */
export function fmtDevs(n: number): string {
  if (!Number.isFinite(n)) return " - ";
  return n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
}

/** A COCOMO cost in US dollars: whole dollars, grouped as the reader's
 *  locale groups digits. */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return " - ";
  return `$${Math.round(n).toLocaleString()}`;
}

/** Last component of a workspace path. A workspace path is separated
 *  by `/` alone: on a Unix server `\` is a character of a name, and a
 *  Windows server spells its paths with `/`. A host's path, such as a
 *  workspace root, is not a workspace path and has rules of its own. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/// Workspace-relative parent directory of `path`, cut at `/` alone as
/// `basename` is. Returns "" for paths at the workspace root (no parent)
/// and for the empty string. Directories follow the same rule as files;
/// the caller decides whether to treat the empty parent as "workspace
/// scope" or skip.
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
