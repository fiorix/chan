import { parentDir } from "../state/format";

export type TerminalFromHereTarget = {
  cwd: string;
  seedInput?: string;
};

const RAW_SAFE = /^[A-Za-z0-9/_.-]+$/;

export function terminalFromHereTarget(
  path: string,
  isDir: boolean,
): TerminalFromHereTarget {
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

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}
