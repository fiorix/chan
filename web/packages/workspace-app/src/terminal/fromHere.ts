import { isDraftClientPath } from "../api/fileIdentity";
import { basename, parentDir } from "../state/format";

export type TerminalFromHereTarget = {
  cwd: string;
  seedInput?: string;
};

const RAW_SAFE = /^[A-Za-z0-9/_.-]+$/;

/// The directory a terminal opens in for `path`, with the file's name
/// seeded as input for a file. A workspace's draft has no directory a
/// terminal can be given: its target is the workspace root, with no seed.
export function terminalFromHereTarget(
  path: string,
  isDir: boolean,
): TerminalFromHereTarget {
  if (isDraftClientPath(path)) return { cwd: "" };
  const normalized = normalizeWorkspacePath(path);
  if (isDir) return { cwd: normalized };
  const parent = parentDir(normalized);
  const base = basename(normalized);
  return { cwd: parent, seedInput: shellQuotePath(base) };
}

export function shellQuotePath(path: string): string {
  if (path === "") return "''";
  if (RAW_SAFE.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function normalizeWorkspacePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}
