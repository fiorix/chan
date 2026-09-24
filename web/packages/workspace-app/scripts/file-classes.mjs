#!/usr/bin/env node
// Print, as JSON, the extension and basename sets in
// web/packages/workspace-app/src/state/fileTypes.ts that mirror
// chan-workspace's path classifier, keyed by the Rust function and the
// `FileClass` each set mirrors. scripts/check-file-classes.py diffs this
// against the Rust match arms.
//
// Usage:
//   node web/packages/workspace-app/scripts/file-classes.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const tsPath = join(here, "..", "src", "state", "fileTypes.ts");
const webDir = join(here, "..");
// Resolve tsc by module path: npm-workspaces hoists `typescript` to the
// web-root `node_modules`, so a package-local `.bin/tsc` does not exist.
const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

// Compile the real module and read its exported sets, so the frontend side of
// the check is the definition the app runs rather than a parse of its source.
const work = mkdtempSync(join(tmpdir(), "chan-file-classes-"));
try {
  const inFile = join(work, "fileTypes.ts");
  copyFileSync(tsPath, inFile);
  execFileSync(
    process.execPath,
    [tscBin, "--target", "es2022", "--module", "es2022", "--moduleResolution", "bundler", "--strict", "--outDir", work, inFile],
    { cwd: webDir, stdio: ["ignore", "ignore", "inherit"] },
  );
  const mod = await import(pathToFileURL(join(work, "fileTypes.js")).href);
  const out = {};
  for (const [fn, classes] of Object.entries(mod.SERVER_CLASSIFIER_MIRROR)) {
    out[fn] = {};
    for (const [fileClass, set] of Object.entries(classes)) {
      out[fn][fileClass] = [...set].sort();
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
