import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../../", import.meta.url);
const stagedSha = new URL("worktree-sha.txt", import.meta.url);

// Guest copies omit .git. Operators stage the pinned source SHA after sync.
export function readWorktreeSha(explicit = process.env.NATIVE_INPUT_SHA) {
  const sha = (explicit || (existsSync(stagedSha) ? readFileSync(stagedSha, "utf8") :
    execFileSync("git", ["-C", fileURLToPath(root), "rev-parse", "HEAD"], { encoding: "utf8" }))).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("native input recorder needs a full worktree SHA");
  return sha;
}

export function recorderIdentity(engine) {
  const paths = ["cases.mjs", "page.mjs", "schema.mjs", "boot-wait.mjs", "identity.mjs", "../ghostty-capture.mjs", "../terminal-fixture.mjs", "../terminal-pointer.mjs",
    engine === "chrome" ? "../../checks/343-native-input-record.mjs" : "../../../desktop-observations/native-input-record.mjs"];
  if (engine === "webkit") paths.push("../../../desktop-observations/native-input-record.sh", "../../../desktop-observations/lib.sh");
  return createHash("sha256").update(paths.map((path) => path + "\n" + readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")).digest("hex");
}
