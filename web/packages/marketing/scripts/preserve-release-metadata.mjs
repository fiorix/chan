#!/usr/bin/env node

// Rebuild the /dl release metadata for a marketing-only Pages deploy.
//
// release.yml owns /dl on every tag, but a manual Pages deploy
// (marketing-only updates between releases) rebuilds dist/ from scratch
// and would otherwise ship without /dl, 404ing the download page and
// the CLI / desktop update checks until the next release.
//
// /dl is regenerated from the GitHub Releases history, the durable source
// of truth (signed updater assets + checksums), exactly the way
// release.yml does: collect-release-assets builds the manifest for the
// latest 5 GA releases, then generate-release-metadata writes the static
// files. It does NOT read the live site.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateReleaseTag } from "./release-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "chan-dl-"));
  try {
    const manifest = path.join(workDir, "release-assets.json");

    // --allow-missing-release: before the first release there is nothing
    // to publish, and a marketing deploy must still succeed. When no
    // release exists the collector skips writing the manifest. It is passed
    // only when no tag was asked for: a named tag that is not published is a
    // mistake, and a deploy that skipped /dl over it would leave every
    // install pointing at nothing.
    // --latest-count 5 mirrors release.yml: /dl keeps the latest GA release
    // plus the 4 previous GA releases upgradeable by explicit version.
    const collectArgs = ["--latest-count", "5", "--out", manifest];
    if (options.tag) collectArgs.push("--tag", options.tag);
    else collectArgs.unshift("--allow-missing-release");
    runScript("collect-release-assets.mjs", collectArgs);

    if (!(await fileExists(manifest))) {
      console.warn("warning: no GitHub Release found; /dl omitted from this build");
      return;
    }

    runScript("generate-release-metadata.mjs", ["--manifest", manifest, "--out", options.out]);
    console.log(`rebuilt /dl metadata from the latest 5 GA GitHub Releases under ${options.out}`);
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
}

function parseArgs(args) {
  const options = { out: "dist/dl", tag: "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") {
      options.out = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--tag") {
      options.tag = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.out) throw new Error("--out requires a value");
  if (options.tag) validateReleaseTag(options.tag, "--tag");
  return options;
}

function printHelp() {
  console.log(`usage: node scripts/preserve-release-metadata.mjs [--out dist/dl] [--tag vX.Y.Z[-rcN]]

Rebuilds /dl into a freshly built Pages artifact from the latest 5 GA GitHub
Releases (or --tag plus its GA predecessors), so a marketing-only deploy keeps
the download page, the update-check metadata, and explicit-version upgrades
for the retained releases intact. Mirrors release.yml's generation path.
`);
}

function runScript(script, args) {
  execFileSync(process.execPath, [path.join(scriptDir, script), ...args], {
    stdio: "inherit",
  });
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(`release metadata preservation failed: ${err.message}`);
  process.exitCode = 1;
});
