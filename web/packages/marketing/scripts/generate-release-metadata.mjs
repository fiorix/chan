#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareVersions,
  escapeRegExp,
  gatewayPackageVersion,
  versionFromTag,
} from "./release-version.mjs";

// The standalone Linux CLI tarball is musl (fully static): a too-new build
// glibc must not gate older machines. install.sh maps Linux arch to these
// musl targets. macOS and FreeBSD use native target triples. FreeBSD is
// optional only for retained releases that predate its v0.96.0 publication;
// the release verifier still requires it for every new GA.
const cliTargets = [
  {
    id: "cli-linux-x64",
    label: "Linux x86_64 tarball (static)",
    target: "x86_64-unknown-linux-musl",
    asset: "chan-x86_64-unknown-linux-musl.tar.gz",
  },
  {
    id: "cli-linux-arm64",
    label: "Linux aarch64 tarball (static)",
    target: "aarch64-unknown-linux-musl",
    asset: "chan-aarch64-unknown-linux-musl.tar.gz",
  },
  {
    id: "cli-macos-arm64",
    label: "macOS aarch64 tarball",
    target: "aarch64-apple-darwin",
    asset: "chan-aarch64-apple-darwin.tar.gz",
  },
  {
    id: "cli-freebsd-x64",
    label: "FreeBSD amd64 tarball (static)",
    target: "x86_64-unknown-freebsd",
    asset: "chan-x86_64-unknown-freebsd.tar.gz",
    archiveOptional: true,
  },
  {
    id: "cli-freebsd-arm64",
    label: "FreeBSD arm64 tarball (static)",
    target: "aarch64-unknown-freebsd",
    asset: "chan-aarch64-unknown-freebsd.tar.gz",
    archiveOptional: true,
  },
];

function desktopDownloads(version) {
  return [
    {
      id: "desktop-macos-dmg",
      kind: "desktop",
      label: "macOS DMG",
      platform: "darwin-aarch64",
      format: "dmg",
      asset: `Chan_${version}.dmg`,
    },
    {
      id: "desktop-linux-appimage",
      kind: "desktop",
      label: "Linux AppImage (amd64)",
      platform: "linux-x86_64",
      format: "appimage",
      asset: `Chan_${version}_amd64.AppImage`,
    },
    {
      id: "desktop-linux-appimage-arm64",
      kind: "desktop",
      label: "Linux AppImage (aarch64)",
      platform: "linux-aarch64",
      format: "appimage",
      asset: `Chan_${version}_aarch64.AppImage`,
    },
  ];
}

// The standalone tarballs are the static musl/FreeBSD and native darwin
// self-upgrade targets. Distro-built CLI packages live in COPR, the PPA, and
// the AUR.
function availableCliTargets(manifest) {
  return cliTargets.filter(
    (target) => !target.archiveOptional || manifest.assets.has(target.asset),
  );
}

function cliDownloads(manifest) {
  return availableCliTargets(manifest).map(({ id, label, target, asset }) => ({
    id,
    kind: "cli",
    label,
    target,
    format: "tar.gz",
    asset,
  }));
}

// Gateway downloads are DERIVED from the manifest's actual assets, not a fixed
// service list: the metadata then reflects whatever gateway debs a given release
// actually shipped (service names can differ across releases) with no list to
// drift. Asset name shape: `chan-gateway-<service>_<version>-1_<arch>.deb`.
function gatewayDownloads(manifest) {
  const versionRe = escapeRegExp(gatewayPackageVersion(manifest.version));
  const re = new RegExp(`^chan-gateway-(.+)_${versionRe}-1_(amd64|arm64)\\.deb$`);
  const found = [];
  for (const name of manifest.assets.keys()) {
    const m = name.match(re);
    if (m) found.push({ service: m[1], arch: m[2], asset: name });
  }
  found.sort(
    (a, b) => a.service.localeCompare(b.service) || a.arch.localeCompare(b.arch),
  );
  return found.map(({ service, arch, asset }) => ({
    id: `gateway-${service}-deb-${arch}`,
    kind: "gateway",
    label: `chan-gateway-${service} deb (${arch})`,
    platform: arch === "amd64" ? "linux-x86_64" : "linux-aarch64",
    format: "deb",
    asset,
  }));
}

// Windows downloads are DERIVED from the manifest (like gateway), not a fixed
// list: the NSIS desktop installer and the standalone Windows CLI zip are
// optional assets (see collect-release-assets.mjs), so they only appear on the
// install page once a release actually ships them. Until then the install-page
// buttons fall back to the GitHub releases page.
function windowsDownloads(manifest) {
  const candidates = [
    {
      id: "desktop-windows-nsis",
      kind: "desktop",
      label: "Windows installer (x64)",
      platform: "windows-x86_64",
      format: "exe",
      asset: `Chan_${manifest.version}_x64-setup.exe`,
    },
    {
      id: "cli-windows-x64",
      kind: "cli",
      label: "Windows x86_64 zip",
      target: "x86_64-pc-windows-msvc",
      format: "zip",
      asset: "chan-x86_64-pc-windows-msvc.zip",
    },
  ];
  return candidates.filter((download) => manifest.assets.has(download.asset));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifests = normalizeManifests(
    JSON.parse(await fs.readFile(options.manifest, "utf8")),
    options,
  );
  const output = buildMetadata(manifests);
  await writeMetadata(options.out, output);
  const retained = manifests.length - 1;
  const suffix = retained > 0 ? ` (+${retained} retained GA releases)` : "";
  console.log(`generated release metadata for ${manifests[0].tag}${suffix} under ${options.out}`);
}

function parseArgs(args) {
  const options = { latestCount: 5, manifest: "", out: "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--latest-count") {
      options.latestCount = parseLatestCount(args[i + 1] ?? "");
      i += 1;
    } else if (arg === "--manifest") {
      options.manifest = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--out") {
      options.out = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.manifest) throw new Error("--manifest is required");
  if (!options.out) throw new Error("--out is required");
  return options;
}

function printHelp() {
  console.log(`usage: node scripts/generate-release-metadata.mjs --manifest release-assets.json --out dist/dl

The manifest must describe already uploaded and verified release assets: a
single manifest object, or an array newest-first as collected with
collect-release-assets.mjs --latest-count. The first manifest drives
cli/latest.json + desktop/latest.json; every retained manifest gets
per-version cli/vX.Y.Z.json + desktop/vX.Y.Z.json files plus a releases.json
entry, so /dl keeps the latest release and up to --latest-count-1 previous GA
releases (default 4) available for explicit-version upgrades.

This script only writes static metadata files; it does not create releases,
upload assets, or publish Pages.
`);
}

function parseLatestCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("--latest-count must be a positive integer");
  }
  return count;
}

// Accepts a single manifest object or an array newest-first (as
// collect-release-assets.mjs --latest-count writes it). Every manifest is
// validated with the single-manifest rules; duplicate versions or tags are
// rejected and the array must be in strictly descending version order, since
// the first entry drives latest.json and releases.json keeps the input
// order. At most options.latestCount manifests are retained, so /dl keeps
// the latest release plus that many previous GA releases minus one.
function normalizeManifests(raw, options) {
  const source = options.manifest;
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) {
    throw new Error(`${source}: manifest array must not be empty`);
  }
  const manifests = entries.map((entry) => normalizeManifest(entry, source));
  const versions = new Set();
  const tags = new Set();
  for (const manifest of manifests) {
    if (versions.has(manifest.version)) {
      throw new Error(`${source}: duplicate version ${manifest.version}`);
    }
    if (tags.has(manifest.tag)) {
      throw new Error(`${source}: duplicate tag ${manifest.tag}`);
    }
    versions.add(manifest.version);
    tags.add(manifest.tag);
  }
  for (let i = 1; i < manifests.length; i += 1) {
    const previous = manifests[i - 1];
    const current = manifests[i];
    if (compareVersions(current.version, previous.version) >= 0) {
      throw new Error(
        `${source}: manifest array must be newest-first ` +
          `(${current.version} sorts at or after ${previous.version})`,
      );
    }
  }
  return manifests.slice(0, options.latestCount);
}

function normalizeManifest(raw, source) {
  const version = requireString(raw.version, "version");
  const tag = requireString(raw.tag, "tag");
  const tagVersion = versionFromTag(tag);
  if (version !== tagVersion) {
    throw new Error(`${source}: version must match ${tag}`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`${source}: tag must be v${version}`);
  }
  const publishedAt = requireString(raw.published_at, "published_at");
  if (Number.isNaN(Date.parse(publishedAt))) {
    throw new Error(`${source}: published_at must be an ISO timestamp`);
  }
  const notes = String(raw.notes ?? "");
  if (!Array.isArray(raw.assets) || raw.assets.length === 0) {
    throw new Error(`${source}: assets must be a non-empty array`);
  }

  const assets = new Map();
  for (const rawAsset of raw.assets) {
    const asset = normalizeAsset(rawAsset, source);
    if (assets.has(asset.name)) {
      throw new Error(`${source}: duplicate asset ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }

  return { assets, notes, publishedAt, tag, version };
}

function normalizeAsset(raw, source) {
  const name = requireString(raw.name, "asset.name");
  const url = requireString(raw.url, `asset ${name} url`);
  if (!url.startsWith("https://")) {
    throw new Error(`${source}: asset ${name} URL must be HTTPS`);
  }
  if (url.includes("/releases/latest/download/")) {
    throw new Error(`${source}: asset ${name} URL must point at a concrete release`);
  }
  const sha256 = requireString(raw.sha256, `asset ${name} sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`${source}: asset ${name} sha256 must be 64 lowercase hex chars`);
  }
  const updaterPlatform = raw.updater_platform ?? raw.updaterPlatform ?? "";
  const signature = raw.signature ?? "";
  if (updaterPlatform && typeof updaterPlatform !== "string") {
    throw new Error(`${source}: asset ${name} updater_platform must be a string`);
  }
  if (updaterPlatform && (typeof signature !== "string" || signature.trim() === "")) {
    throw new Error(`${source}: asset ${name} updater signature is required`);
  }
  return {
    name,
    sha256,
    signature: String(signature),
    updaterPlatform: String(updaterPlatform),
    url,
  };
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function buildMetadata(manifests) {
  const entries = manifests.map(buildRelease);
  const latest = entries[0];
  const releases = {
    schema_version: 1,
    latest: latest.cli.version,
    latest_tag: latest.cli.tag,
    releases: entries.map((entry) => entry.release),
  };
  return { entries, releases };
}

function buildRelease(manifest) {
  const cli = {
    schema_version: 1,
    version: manifest.version,
    tag: manifest.tag,
    published_at: manifest.publishedAt,
    targets: availableCliTargets(manifest).map((target) => {
      const asset = requireAsset(manifest, target.asset);
      return {
        target: target.target,
        asset: asset.name,
        url: asset.url,
        sha256: asset.sha256,
      };
    }),
  };

  const publicDownloads = [
    ...desktopDownloads(manifest.version),
    ...cliDownloads(manifest),
    ...gatewayDownloads(manifest),
    ...windowsDownloads(manifest),
  ].map((download) => {
    const asset = requireAsset(manifest, download.asset);
    return {
      ...download,
      asset: asset.name,
      url: asset.url,
      sha256: asset.sha256,
    };
  });

  const desktop = {
    version: manifest.version,
    notes: manifest.notes,
    pub_date: manifest.publishedAt,
    platforms: desktopPlatforms(manifest),
  };

  const release = {
    version: manifest.version,
    tag: manifest.tag,
    published_at: manifest.publishedAt,
    notes: manifest.notes,
    cli: `/dl/cli/${manifest.tag}.json`,
    desktop: `/dl/desktop/${manifest.tag}.json`,
    downloads: publicDownloads,
  };

  return { cli, desktop, release };
}

function desktopPlatforms(manifest) {
  const platforms = {};
  for (const asset of manifest.assets.values()) {
    if (!asset.updaterPlatform) continue;
    if (platforms[asset.updaterPlatform]) {
      throw new Error(`duplicate desktop updater platform ${asset.updaterPlatform}`);
    }
    platforms[asset.updaterPlatform] = {
      signature: asset.signature,
      url: asset.url,
    };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error("at least one signed desktop updater platform is required");
  }
  return platforms;
}

function requireAsset(manifest, name) {
  const asset = manifest.assets.get(name);
  if (!asset) throw new Error(`release asset manifest is missing ${name}`);
  return asset;
}

async function writeMetadata(outRoot, { entries, releases }) {
  await fs.mkdir(path.join(outRoot, "cli"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "desktop"), { recursive: true });
  await writeJson(path.join(outRoot, "releases.json"), releases);
  const latest = entries[0];
  await writeJson(path.join(outRoot, "cli", "latest.json"), latest.cli);
  await writeJson(path.join(outRoot, "desktop", "latest.json"), latest.desktop);
  for (const entry of entries) {
    await writeJson(path.join(outRoot, "cli", `${entry.cli.tag}.json`), entry.cli);
    await writeJson(path.join(outRoot, "desktop", `${entry.cli.tag}.json`), entry.desktop);
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`release metadata generation failed: ${err.message}`);
  process.exitCode = 1;
});
