#!/usr/bin/env node
// Print the keyboard-shortcut table from web/packages/workspace-app/src/state/shortcuts.ts.
// Two modes:
//   default                   plain ASCII (what the empty pane renders)
//   --serve-long-about        just the indented table, for the Rust const
//                             KEYBINDINGS_TABLE in crates/chan/src/lib.rs.
//
// Usage:
//   node web/packages/workspace-app/scripts/shortcuts-table.mjs
//   node web/packages/workspace-app/scripts/shortcuts-table.mjs --serve-long-about
//
// Pick `--platform` (web | native) and `--os` (mac | linux | windows)
// to render alternate variants; defaults to the web fallback set with
// `Mod` rendered as `Cmd` (the same shape the embedded help table
// uses).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tsPath = join(here, "..", "src", "state", "shortcuts.ts");
const webDir = join(here, "..");
// Resolve tsc by module path rather than a package-local `.bin` symlink:
// npm-workspaces hoists `typescript` to the web-root `node_modules`, so a
// relative `node_modules/.bin/tsc` from this package does not exist.
const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

// Compile shortcuts.ts to a temp .mjs and import. Keeps shortcuts.ts
// as the only place chord data lives - no parallel JS shadow file
// to drift out of sync. tsc is already installed for the web build.
const work = mkdtempSync(join(tmpdir(), "chan-shortcuts-"));
try {
  const inFile = join(work, "shortcuts.ts");
  // The temporary directory is outside the npm workspace, so compile the
  // registry's shared helper beside it with a local module specifier.
  writeFileSync(
    join(work, "keyboard.ts"),
    readFileSync(require.resolve("@chan/web-shared/keyboard"), "utf8"),
  );
  writeFileSync(
    inFile,
    readFileSync(tsPath, "utf8").replace(
      'from "@chan/web-shared/keyboard"',
      'from "./keyboard.js"',
    ),
  );
  execFileSync(
    process.execPath,
    [tscBin, "--target", "es2022", "--module", "es2022", "--moduleResolution", "bundler", "--strict", "--outDir", work, inFile],
    { cwd: webDir, stdio: ["ignore", "ignore", "inherit"] },
  );
  const outFile = join(work, "shortcuts.js");
  const mod = await import(pathToFileURL(outFile).href);

  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const wrap = args.includes("--serve-long-about");
  const platform = flag("--platform", "web");
  const os = flag("--os", "mac");

  // The help framing indents the table by two, and chan's help text is
  // hand-wrapped at 76 columns because clap prints it verbatim. Leave the
  // plain mode uncapped: only the help output has a column budget.
  const table = wrap
    ? mod.renderTable(platform, os, 74)
    : mod.renderTable(platform, os);

  if (!wrap) {
    process.stdout.write(table + "\n");
  } else {
    // The body of KEYBINDINGS_TABLE in crates/chan/src/lib.rs: the table
    // alone, indented, with no surrounding prose. The Rust side owns the
    // framing, so a wording change there does not need a resync here.
    // Indent only non-empty lines: indenting the group separators would
    // bake trailing whitespace into the Rust const.
    process.stdout.write(table.replace(/^(?=.)/gm, "  ") + "\n");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
