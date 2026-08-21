#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  cliAssets,
  desktopAssets,
  gatewayDebAssets,
  updaterPayloads,
  windowsAssets,
} from "./release-assets.mjs";
import {
  compareVersions,
  validateReleaseTag,
  versionFromTag,
} from "./release-version.mjs";

const defaultRepo = "fiorix/chan";

// The asset name lists (CLI, desktop, gateway .debs, Windows, updater) are
// single-sourced in release-assets.mjs and must stay in sync with the download
// lists in generate-release-metadata.mjs. Here they get a SHA256 + browser URL
// in the manifest.

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.latestCount > 0) {
    const releases = await loadReleaseHistory(options);
    if (!releases) return;
    const manifests = [];
    for (const release of releases) {
      manifests.push(await collectManifest(release, options));
    }
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(manifests, null, 2)}\n`);
    const tags = manifests.map((manifest) => manifest.tag).join(", ");
    console.log(
      `wrote release asset manifest for ${manifests.length} releases (${tags}) to ${options.out}`,
    );
    return;
  }

  const release = await loadRelease(options);
  if (!release) return;

  const manifest = await collectManifest(release, options);
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote release asset manifest for ${manifest.tag} to ${options.out}`);
}

function parseArgs(args) {
  const options = {
    allowMissingRelease: false,
    assetDir: "",
    latestCount: 0,
    out: "",
    releaseJson: "",
    repo: defaultRepo,
    tag: "",
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--allow-missing-release") {
      options.allowMissingRelease = true;
    } else if (arg === "--asset-dir") {
      options.assetDir = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--latest-count") {
      options.latestCount = parseLatestCount(args[i + 1] ?? "");
      i += 1;
    } else if (arg === "--out") {
      options.out = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--release-json") {
      options.releaseJson = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo") {
      options.repo = args[i + 1] ?? "";
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
  if (!options.out) throw new Error("--out is required");
  if (!options.repo) throw new Error("--repo requires a value");
  if (options.assetDir && !options.releaseJson) {
    throw new Error("--asset-dir is only valid with --release-json");
  }
  if (options.releaseJson && !options.assetDir) {
    throw new Error("--release-json requires --asset-dir");
  }
  if (options.tag) validateReleaseTag(options.tag, "--tag");
  return options;
}

function printHelp() {
  console.log(`usage: node scripts/collect-release-assets.mjs --out release-assets.json [--tag vX.Y.Z[-rcN]] [--latest-count N]

Collects uploaded GitHub Release assets into the manifest consumed by
generate-release-metadata.mjs. The script downloads asset bytes to compute
SHA256 values (unless the GitHub API already reports a "sha256:<hex>" digest
for the asset) and reads updater signature assets for signed platform entries.

With --latest-count N the output is an array of manifests, newest first: the
requested tag (or the latest GA release) plus its GA predecessors, so /dl
keeps the latest release and N-1 previous GA releases upgradeable by explicit
version. Prerelease and draft releases are never collected from the releases
list, and an explicit --tag must be GA and the newest retained release: the
script refuses to publish a prerelease or a stale tag to /dl. With
--release-json, the fixture may hold one release object or an array standing
in for the releases list.
`);
}

function parseLatestCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("--latest-count must be a positive integer");
  }
  return count;
}

async function loadRelease(options) {
  if (options.releaseJson) {
    return JSON.parse(await fs.readFile(options.releaseJson, "utf8"));
  }

  const apiBase = `https://api.github.com/repos/${options.repo}`;
  const url = options.tag
    ? `${apiBase}/releases/tags/${encodeURIComponent(options.tag)}`
    : `${apiBase}/releases/latest`;
  return fetchRelease(url, options);
}

async function fetchRelease(url, options) {
  const response = await request(url);
  if (response.status === 404 && options.allowMissingRelease) {
    console.warn("warning: no GitHub Release found; skipping /dl metadata");
    return null;
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

// History mode (--latest-count N): select the newest N GA releases. An
// explicitly requested --tag (the release being published) must be GA and
// must end up the newest entry, since it drives latest.json. Prerelease and
// draft entries are filtered out of the releases list so rc builds never
// land in /dl. The retained set is sorted newest-first by semver, never by
// API order (the releases list is created_at-ordered, not version-ordered).
// With --release-json the fixture may hold either one release object (the
// requested release, held to the same GA rules) or an array standing in for
// the releases list.
async function loadReleaseHistory(options) {
  let requested = null;
  let listed = [];
  if (options.releaseJson) {
    const raw = JSON.parse(await fs.readFile(options.releaseJson, "utf8"));
    if (Array.isArray(raw)) {
      listed = raw;
    } else {
      requested = raw;
    }
  } else {
    const apiBase = `https://api.github.com/repos/${options.repo}`;
    if (options.tag) {
      requested = await fetchRelease(
        `${apiBase}/releases/tags/${encodeURIComponent(options.tag)}`,
        options,
      );
      if (!requested) return null;
    }
    const listUrl = `${apiBase}/releases?per_page=100`;
    const response = await request(listUrl);
    if (!response.ok) {
      throw new Error(`${listUrl} returned HTTP ${response.status}`);
    }
    listed = await response.json();
  }

  // The requested release is published to /dl verbatim, so it must be GA:
  // a forced rc/prerelease/draft tag would otherwise land in latest.json
  // and every GA install would self-upgrade onto it.
  if (requested && !isGaRelease(requested)) {
    const tag = typeof requested.tag_name === "string" ? requested.tag_name : options.tag;
    throw new Error(`refusing to publish non-GA tag ${tag} to /dl`);
  }

  const releases = [];
  const seen = new Set();
  const push = (release) => {
    const tag = requireString(release.tag_name, "release.tag_name");
    if (seen.has(tag)) return;
    seen.add(tag);
    releases.push(release);
  };
  if (requested) push(requested);
  for (const release of listed) {
    if (!isGaRelease(release)) continue;
    push(release);
  }

  releases.sort((a, b) =>
    compareVersions(versionFromTag(b.tag_name), versionFromTag(a.tag_name)),
  );

  if (
    options.tag &&
    !requested &&
    !releases.some((release) => release.tag_name === options.tag)
  ) {
    throw new Error(`requested tag ${options.tag} not found in the GA release history`);
  }

  const selected = releases.slice(0, options.latestCount);
  if (selected.length === 0) {
    if (options.allowMissingRelease) {
      console.warn("warning: no GA GitHub Release found; skipping /dl metadata");
      return null;
    }
    throw new Error("no GA releases found to collect");
  }

  // An explicit --tag that is not the newest GA release would silently
  // demote the true latest (or drop it entirely with a small window), so
  // refuse it instead of writing a stale latest.json.
  if (options.tag && selected[0].tag_name !== options.tag) {
    throw new Error(
      `--tag ${options.tag} is not the newest GA release (newest is ${selected[0].tag_name}); ` +
        "refusing to publish it as /dl latest",
    );
  }
  return selected;
}

function isGaRelease(release) {
  if (release?.draft || release?.prerelease) return false;
  const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

async function collectManifest(release, options) {
  const tag = requireString(release.tag_name, "release.tag_name");
  const version = versionFromTag(tag);
  const publishedAt = requireString(
    release.published_at ?? release.created_at,
    "release.published_at",
  );
  const releaseAssets = new Map();
  for (const asset of release.assets ?? []) {
    const name = requireString(asset.name, "asset.name");
    if (releaseAssets.has(name)) throw new Error(`duplicate release asset ${name}`);
    releaseAssets.set(name, asset);
  }

  const assets = [];
  for (const name of [...cliAssets(), ...desktopAssets(version)]) {
    assets.push(await collectAsset(name, releaseAssets, options));
  }
  // Gateway .debs and Windows are REQUIRED by the verifier for the release
  // being cut (release.yml gates publish on the gateway and windows jobs), but
  // the collector keeps them OPTIONAL on purpose: it also walks archived
  // releases via --latest-count, and an older release legitimately predates a
  // gateway service (devserver-control arrived in 0.74.0) or the Windows
  // artifacts, so a missing one must not fail that release's /dl metadata.
  // Collect each only when the release actually shipped it.
  for (const name of [...gatewayDebAssets(version), ...windowsAssets(version)]) {
    if (!releaseAssets.has(name)) continue;
    assets.push(await collectAsset(name, releaseAssets, options));
  }
  // Updater payloads carry a Tauri platform key and their detached minisign
  // signature. The macOS payload is its own asset (the DMG is the public
  // download) and is collected here; each AppImage and the NSIS installer
  // were already collected as public downloads above, so their records are
  // decorated in place, because the generator rejects a duplicate asset name.
  // The AppImage and installer signatures stay OPTIONAL for the archived
  // releases --latest-count walks (they predate the signatures, and the
  // Windows artifacts themselves are optional there; the first GA that adds
  // them must not fail the whole /dl history); the release being cut is held
  // to every signature by the verifier, which release.yml runs before this
  // script.
  for (const payload of updaterPayloads(version)) {
    const signatureName = `${payload.asset}.sig`;
    if (
      !payload.required &&
      (!releaseAssets.has(payload.asset) || !releaseAssets.has(signatureName))
    ) {
      continue;
    }
    const signature = await collectSignature(signatureName, releaseAssets, options);
    const collected = assets.find((asset) => asset.name === payload.asset);
    if (collected) {
      collected.signature = signature;
      collected.updater_platform = payload.platform;
      continue;
    }
    assets.push({
      ...(await collectAsset(payload.asset, releaseAssets, options)),
      signature,
      updater_platform: payload.platform,
    });
  }

  return {
    version,
    tag,
    published_at: publishedAt,
    notes: String(release.body ?? ""),
    assets,
  };
}

async function collectAsset(name, releaseAssets, options) {
  const asset = releaseAssets.get(name);
  if (!asset) throw new Error(`missing release asset: ${name}`);
  const url = requireString(asset.browser_download_url, `${name} browser_download_url`);
  const digest = digestSha256(asset);
  if (digest) return { name, url, sha256: digest };
  const bytes = await readAssetBytes(asset, options);
  return {
    name,
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// The GitHub API reports asset digests as "sha256:<hex>"; trust those instead
// of re-downloading bytes just to hash them. Local fixtures and old API
// responses without a digest still take the download-and-hash path.
function digestSha256(asset) {
  const digest = typeof asset.digest === "string" ? asset.digest.trim() : "";
  const match = digest.match(/^sha256:([0-9a-fA-F]{64})$/);
  return match ? match[1].toLowerCase() : "";
}

async function collectSignature(name, releaseAssets, options) {
  const asset = releaseAssets.get(name);
  if (!asset) throw new Error(`missing release asset: ${name}`);
  const bytes = await readAssetBytes(asset, options);
  const signature = bytes.toString("utf8").trim();
  if (!signature) throw new Error(`empty updater signature asset: ${name}`);
  return signature;
}

async function readAssetBytes(asset, options) {
  if (options.assetDir) {
    return fs.readFile(path.join(options.assetDir, asset.name));
  }
  const response = await request(requireString(asset.url, `${asset.name} url`), {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`${asset.name} returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

async function request(url, init = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "chan-release-asset-collector",
    ...init.headers,
  };
  const token = readGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...init, headers });
}

function readGithubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

main().catch((err) => {
  console.error(`release asset collection failed: ${err.message}`);
  process.exitCode = 1;
});
