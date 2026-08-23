#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  archiveOptionalCliAssets,
  cliAssets,
  desktopAssets,
  gatewayDebAssets,
  updaterAssets,
  windowsAssets,
} from "./release-assets.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "0.15.4";
const tag = `v${version}`;
const firstCliAsset = cliAssets()[0];
// The manifest holds one entry per required asset except the updater's detached
// .sig files, which are folded into their payload entries: cli + desktop +
// gateway debs + the one updater payload that is not already a public download
// (the macOS tarball; the AppImages are desktop downloads decorated in place).
// Derived so a gateway-service change can't drift the count.
const baseAssetCount =
  cliAssets().length + desktopAssets(version).length + gatewayDebAssets(version).length + 1;
const windowsAssetCount = baseAssetCount + windowsAssets(version).length;

const root = mkdtempSync(path.join(tmpdir(), "chan-release-assets-"));
try {
  // An archived release still carrying the dropped desktop deb/rpm (the
  // preserve-release-metadata five-release re-run scenario) must not fail
  // and must not leak them into the collected manifest.
  const droppedDesktopNames = [`Chan_${version}_amd64.deb`, `Chan-${version}-1.x86_64.rpm`];
  // No Windows assets: the optional Windows entries are skipped, not an error.
  const base = runCollect("base", version, droppedDesktopNames);
  assertEqual(base.version, version, "version");
  assertEqual(base.tag, tag, "tag");
  assertEqual(base.assets.length, baseAssetCount, "asset count excludes detached sig");
  assert(
    !base.assets.some((asset) => asset.name.endsWith("-setup.exe")),
    "windows installer absent when not in the release",
  );
  assert(
    !base.assets.some((asset) => asset.name.endsWith("windows-msvc.zip")),
    "windows cli absent when not in the release",
  );
  for (const name of droppedDesktopNames) {
    assert(
      !base.assets.some((asset) => asset.name === name),
      `dropped desktop asset ${name} not collected`,
    );
  }

  const cli = base.assets.find((asset) => asset.name === firstCliAsset);
  assert(cli, "missing CLI asset");
  assertEqual(
    cli.sha256,
    createHash("sha256").update(`asset bytes for ${firstCliAsset}\n`).digest("hex"),
    "CLI sha256",
  );

  const updater = base.assets.find((asset) => asset.updater_platform === "darwin-aarch64");
  assert(updater, "missing updater asset");
  assertEqual(updater.signature, "fixture-updater-signature", "updater signature");

  // The AppImages are the Linux updater payloads: each public download record
  // is decorated with its platform key and signature, not duplicated.
  for (const [platform, arch] of [["linux-x86_64", "amd64"], ["linux-aarch64", "aarch64"]]) {
    const appimage = base.assets.find((asset) => asset.updater_platform === platform);
    assert(appimage, `missing ${platform} updater decoration`);
    assertEqual(appimage.name, `Chan_${version}_${arch}.AppImage`, `${platform} payload`);
    assertEqual(appimage.signature, "fixture-updater-signature", `${platform} signature`);
  }
  assertEqual(
    base.assets.filter((asset) => asset.name.endsWith(".AppImage")).length,
    2,
    "AppImages decorated in place, not duplicated",
  );
  // The installer signature is in the fixture but the installer is not: an
  // optional payload is skipped whole, never collected from its signature.
  assert(
    !base.assets.some((asset) => asset.updater_platform === "windows-x86_64"),
    "windows updater platform absent when the installer is not in the release",
  );

  // Windows assets present: the optional entries are collected, and the NSIS
  // installer is decorated in place as the Windows updater payload.
  const windowsNames = optionalNames(version);
  const win = runCollect("windows", version, windowsNames);
  assertEqual(win.assets.length, windowsAssetCount, "windows assets collected when present");
  assert(
    win.assets.some((asset) => asset.name === windowsNames[0]),
    "windows installer collected",
  );
  assert(
    win.assets.some((asset) => asset.name === windowsNames[1]),
    "windows cli collected",
  );
  const winInstaller = win.assets.find((asset) => asset.updater_platform === "windows-x86_64");
  assert(winInstaller, "missing windows-x86_64 updater decoration");
  assertEqual(winInstaller.name, windowsNames[0], "windows-x86_64 payload is the installer");
  assertEqual(winInstaller.signature, "fixture-updater-signature", "windows-x86_64 signature");

  // Prerelease assets keep the Cargo version in desktop names but gateway
  // debs use cargo-deb's package-version spelling.
  const prereleaseVersion = "0.56.0-rc1";
  const prerelease = runCollect("prerelease", prereleaseVersion, optionalNames(prereleaseVersion));
  assertEqual(prerelease.version, prereleaseVersion, "prerelease version");
  assertEqual(prerelease.tag, `v${prereleaseVersion}`, "prerelease tag");
  assert(
    prerelease.assets.some((asset) => asset.name === "Chan_0.56.0-rc1_amd64.AppImage"),
    "prerelease desktop AppImage collected",
  );
  assert(
    prerelease.assets.some((asset) => asset.name === "chan-gateway-admin_0.56.0.rc1-1_amd64.deb"),
    "prerelease gateway deb collected",
  );

  // Digest fast-path: an asset carrying a GitHub API "sha256:<hex>" digest
  // uses it verbatim; the on-disk bytes (which hash differently) are ignored.
  const digestNames = new Set([
    "chan-aarch64-unknown-linux-musl.tar.gz",
    `Chan_${version}.dmg`,
  ]);
  const dig = runCollect("digest", version, [], digestNames);
  for (const name of digestNames) {
    const asset = dig.assets.find((entry) => entry.name === name);
    assert(asset, `missing digest asset ${name}`);
    assertEqual(asset.sha256, digestFor(tag, name), `digest fast-path sha256 for ${name}`);
  }
  assertEqual(
    dig.assets.find((entry) => entry.name === firstCliAsset).sha256,
    createHash("sha256").update(`asset bytes for ${firstCliAsset}\n`).digest("hex"),
    "fallback sha256 without digest",
  );

  // History mode (--latest-count N): GA releases are kept and sorted
  // newest-first by semver (the out-of-order fixture list proves the sort),
  // rc tags and prerelease/draft entries are filtered out, and the output is
  // a manifest array that generate-release-metadata.mjs consumes as-is.
  const history = [
    { releaseVersion: "0.15.8" },
    { releaseVersion: "0.16.0-rc1" },
    { releaseVersion: "0.15.9" },
    { releaseVersion: "0.15.7", prerelease: true },
    { releaseVersion: "0.15.4" },
    { releaseVersion: "0.15.5", draft: true },
    { releaseVersion: "0.15.6" },
  ];
  const historyRun = runFixtureCollect("history", history, { latestCount: 5 });
  assertEqual(
    JSON.stringify(historyRun.manifests.map((manifest) => manifest.tag)),
    JSON.stringify(["v0.15.9", "v0.15.8", "v0.15.6", "v0.15.4"]),
    "history keeps GA releases sorted newest-first",
  );
  const historyUpdater = historyRun.manifests[0].assets.find(
    (asset) => asset.updater_platform === "darwin-aarch64",
  );
  assertEqual(historyUpdater.signature, "fixture-updater-signature", "history updater signature");
  assertEqual(
    historyRun.manifests[0].assets.find((asset) => asset.name === firstCliAsset).sha256,
    digestFor("v0.15.9", firstCliAsset),
    "history asset uses digest",
  );

  // An archived release that predates a gateway service (devserver-control
  // arrived in 0.74.0) ships no deb for it, so the collector must skip the
  // missing gateway deb the way it skips Windows, not throw and abort the whole
  // /dl history. Reproduces the 0.74.0 GA pages-artifact failure.
  const controlDebs = (v) =>
    gatewayDebAssets(v).filter((name) => name.includes("devserver-control"));
  const sparse = runFixtureCollect(
    "sparse-gateway",
    [
      { releaseVersion: "0.74.0" },
      {
        releaseVersion: "0.73.0",
        omit: [...controlDebs("0.73.0"), ...archiveOptionalCliAssets()],
      },
    ],
    { latestCount: 5 },
  );
  assertEqual(
    JSON.stringify(sparse.manifests.map((manifest) => manifest.tag)),
    JSON.stringify(["v0.74.0", "v0.73.0"]),
    "archived release missing a gateway service is still collected",
  );
  const archived = sparse.manifests.find((manifest) => manifest.tag === "v0.73.0");
  assert(
    !archived.assets.some((asset) => asset.name.includes("devserver-control")),
    "the gateway service the archived release lacks is absent from its manifest",
  );
  assert(
    archived.assets.some((asset) => asset.name.includes("chan-gateway-identity")),
    "the gateway services the archived release did ship are still collected",
  );
  assert(
    !archived.assets.some((asset) => asset.name.endsWith("unknown-freebsd.tar.gz")),
    "an archived release that predates FreeBSD remains collectable",
  );
  const sparseDl = path.join(root, "sparse-gateway", "dl");
  execFileSync("node", [
    "scripts/generate-release-metadata.mjs",
    "--manifest",
    sparse.manifestPath,
    "--out",
    sparseDl,
  ], { cwd: siteRoot });
  const currentSparseCli = JSON.parse(
    readFileSync(path.join(sparseDl, "cli", "latest.json"), "utf8"),
  );
  const archivedSparseCli = JSON.parse(
    readFileSync(path.join(sparseDl, "cli", "v0.73.0.json"), "utf8"),
  );
  assertEqual(currentSparseCli.targets.length, 4, "current release includes FreeBSD target");
  assertEqual(archivedSparseCli.targets.length, 3, "pre-FreeBSD release retains three targets");

  // An archived release that predates the AppImage updater signatures ships
  // no .AppImage.sig, so the collector must keep it (with no Linux updater
  // platform) rather than fail the whole /dl history on the first GA that
  // adds them; the release that does ship them is decorated as usual.
  const appimageSigs = (v) => updaterAssets(v).filter((name) => name.endsWith(".AppImage.sig"));
  const unsigned = runFixtureCollect(
    "unsigned-appimage",
    [{ releaseVersion: "0.95.0" }, { releaseVersion: "0.94.0", omit: appimageSigs("0.94.0") }],
    { latestCount: 5 },
  );
  const unsignedOlder = unsigned.manifests.find((manifest) => manifest.tag === "v0.94.0");
  assert(unsignedOlder, "archived release without AppImage signatures is still collected");
  assert(
    !unsignedOlder.assets.some((asset) => asset.updater_platform?.startsWith("linux-")),
    "archived release without AppImage signatures has no Linux updater platform",
  );
  assert(
    unsignedOlder.assets.some((asset) => asset.updater_platform === "darwin-aarch64"),
    "archived release keeps its macOS updater platform",
  );
  const unsignedNewer = unsigned.manifests.find((manifest) => manifest.tag === "v0.95.0");
  assert(
    unsignedNewer.assets.some((asset) => asset.updater_platform === "linux-x86_64"),
    "the release that ships AppImage signatures is decorated",
  );
  const unsignedDl = path.join(root, "unsigned-appimage", "dl");
  execFileSync("node", [
    "scripts/generate-release-metadata.mjs",
    "--manifest",
    unsigned.manifestPath,
    "--out",
    unsignedDl,
  ], { cwd: siteRoot });
  const unsignedOlderDesktop = JSON.parse(
    readFileSync(path.join(unsignedDl, "desktop", "v0.94.0.json"), "utf8"),
  );
  assertEqual(
    JSON.stringify(Object.keys(unsignedOlderDesktop.platforms)),
    JSON.stringify(["darwin-aarch64"]),
    "archived desktop manifest carries only the platforms it signed",
  );
  const unsignedNewerDesktop = JSON.parse(
    readFileSync(path.join(unsignedDl, "desktop", "latest.json"), "utf8"),
  );
  assert(
    unsignedNewerDesktop.platforms["linux-x86_64"]?.url.endsWith("/Chan_0.95.0_amd64.AppImage"),
    "latest desktop manifest points the Linux platform at the AppImage itself",
  );

  // A GA forced tag that leads the history keeps its place at the front.
  const forced = runFixtureCollect("forced", history, { latestCount: 2, tag: "v0.15.9" });
  assertEqual(
    JSON.stringify(forced.manifests.map((manifest) => manifest.tag)),
    JSON.stringify(["v0.15.9", "v0.15.8"]),
    "requested GA tag leads the window",
  );

  // A GA forced tag with no list behind it collects as a one-entry window.
  const solo = runFixtureCollect("forced-solo", { releaseVersion: "0.15.9" }, { latestCount: 5 });
  assert(Array.isArray(solo.manifests), "history mode emits a manifest array");
  assertEqual(solo.manifests.length, 1, "single forced release collected");
  assertEqual(solo.manifests[0].tag, "v0.15.9", "single forced release tag");

  // A non-GA forced tag never reaches /dl: rc-tagged, prerelease-flagged,
  // and draft-flagged requested releases are all rejected outright.
  const rcError = runFixtureCollectExpectFail(
    "forced-rc",
    { releaseVersion: "0.56.0-rc1" },
    { latestCount: 5 },
  );
  assert(rcError.includes("non-GA"), "rc forced tag rejected");
  const forcedPrereleaseError = runFixtureCollectExpectFail(
    "forced-prerelease",
    { releaseVersion: "0.15.9", prerelease: true },
    { latestCount: 5 },
  );
  assert(forcedPrereleaseError.includes("non-GA"), "prerelease-flagged forced tag rejected");
  const draftError = runFixtureCollectExpectFail(
    "forced-draft",
    { releaseVersion: "0.15.9", draft: true },
    { latestCount: 5 },
  );
  assert(draftError.includes("non-GA"), "draft forced tag rejected");

  // A forced tag that is not the newest GA release is rejected instead of
  // becoming latest.json; a tag missing from the history is an error too.
  const staleError = runFixtureCollectExpectFail("forced-stale", history, {
    latestCount: 5,
    tag: "v0.15.6",
  });
  assert(staleError.includes("not the newest"), "stale forced tag rejected");
  const missingError = runFixtureCollectExpectFail("forced-missing", history, {
    latestCount: 5,
    tag: "v0.15.3",
  });
  assert(missingError.includes("not found"), "missing forced tag rejected");

  // Integration pin: the collector's history array feeds the generator
  // unchanged, producing the retained /dl tree with well-formed content.
  const dlOut = path.join(root, "history", "dl");
  execFileSync("node", [
    "scripts/generate-release-metadata.mjs",
    "--manifest",
    historyRun.manifestPath,
    "--out",
    dlOut,
  ], { cwd: siteRoot });
  const dlReleases = JSON.parse(readFileSync(path.join(dlOut, "releases.json"), "utf8"));
  assertEqual(dlReleases.releases.length, 4, "releases.json carries all retained releases");
  assertEqual(dlReleases.latest, "0.15.9", "releases.json latest");
  assertEqual(dlReleases.latest_tag, "v0.15.9", "releases.json latest_tag");
  assertEqual(
    JSON.stringify(dlReleases.releases.map((entry) => entry.tag)),
    JSON.stringify(["v0.15.9", "v0.15.8", "v0.15.6", "v0.15.4"]),
    "releases.json entries newest-first",
  );
  for (const retained of ["v0.15.9", "v0.15.8", "v0.15.6", "v0.15.4"]) {
    const retainedVersion = retained.slice(1);
    const cliJson = JSON.parse(readFileSync(path.join(dlOut, "cli", `${retained}.json`), "utf8"));
    assertEqual(cliJson.version, retainedVersion, `cli ${retained} version`);
    assertEqual(cliJson.tag, retained, `cli ${retained} tag`);
    assertEqual(cliJson.targets.length, 4, `cli ${retained} target count`);
    assert(
      cliJson.targets.every((target) => /^[a-f0-9]{64}$/.test(target.sha256)),
      `cli ${retained} sha256 values`,
    );
    assertEqual(
      cliJson.targets.find((target) => target.asset === firstCliAsset)?.sha256,
      digestFor(retained, firstCliAsset),
      `cli ${retained} digest sha256`,
    );
    const desktopJson = JSON.parse(
      readFileSync(path.join(dlOut, "desktop", `${retained}.json`), "utf8"),
    );
    assertEqual(desktopJson.version, retainedVersion, `desktop ${retained} version`);
    assertEqual(
      desktopJson.platforms["darwin-aarch64"]?.signature,
      "fixture-updater-signature",
      `desktop ${retained} updater signature`,
    );
    assert(
      desktopJson.platforms["darwin-aarch64"]?.url.includes(`/${retained}/`),
      `desktop ${retained} updater url`,
    );
    for (const platform of ["linux-x86_64", "linux-aarch64"]) {
      assertEqual(
        desktopJson.platforms[platform]?.signature,
        "fixture-updater-signature",
        `desktop ${retained} ${platform} updater signature`,
      );
      assert(
        desktopJson.platforms[platform]?.url.endsWith(".AppImage"),
        `desktop ${retained} ${platform} updater url is the AppImage`,
      );
    }
  }
  assert(!existsSync(path.join(dlOut, "cli", "v0.16.0-rc1.json")), "rc tag filtered out of /dl");
  assert(!existsSync(path.join(dlOut, "cli", "v0.15.7.json")), "prerelease filtered out of /dl");
  assert(!existsSync(path.join(dlOut, "cli", "v0.15.5.json")), "draft filtered out of /dl");
  console.log("smoked release asset manifest collection");
} finally {
  rmSync(root, { force: true, recursive: true });
}

// The required names (including the updater payload and its detached .sig, both
// written to the fixture asset dir) and the optional Windows names, both
// single-sourced from release-assets.mjs.
function namesFor(releaseVersion) {
  return [
    ...cliAssets(),
    ...desktopAssets(releaseVersion),
    ...gatewayDebAssets(releaseVersion),
    ...updaterAssets(releaseVersion),
  ];
}

function optionalNames(releaseVersion) {
  return windowsAssets(releaseVersion);
}

function runCollect(label, releaseVersion, extraNames, digestNames = new Set()) {
  const releaseTag = `v${releaseVersion}`;
  const runRoot = path.join(root, label);
  const assetDir = path.join(runRoot, "assets");
  mkdirSync(assetDir, { recursive: true });
  const release = {
    tag_name: releaseTag,
    published_at: "2026-05-27T00:00:00Z",
    body: "Fixture release",
    assets: [],
  };
  for (const name of [...namesFor(releaseVersion), ...extraNames]) {
    const body = name.endsWith(".sig")
      ? "fixture-updater-signature\n"
      : `asset bytes for ${name}\n`;
    writeFileSync(path.join(assetDir, name), body);
    const asset = {
      name,
      url: `https://api.github.com/repos/fiorix/chan/releases/assets/${encodeURIComponent(name)}`,
      browser_download_url: `https://github.com/fiorix/chan/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
    };
    if (digestNames.has(name)) asset.digest = `sha256:${digestFor(releaseTag, name)}`;
    release.assets.push(asset);
  }

  const releaseJson = path.join(runRoot, "release.json");
  const out = path.join(runRoot, "manifest.json");
  writeFileSync(releaseJson, `${JSON.stringify(release, null, 2)}\n`);
  execFileSync("node", [
    "scripts/collect-release-assets.mjs",
    "--release-json",
    releaseJson,
    "--asset-dir",
    assetDir,
    "--out",
    out,
  ], { cwd: siteRoot });

  return JSON.parse(readFileSync(out, "utf8"));
}

// A release object in the shape of the GitHub API, with a digest on every
// non-sig asset so collection needs no asset bytes; only the updater
// signature is read from disk (into assetDir).
function buildReleaseObject({ releaseVersion, prerelease = false, draft = false, omit = [] }, assetDir) {
  const releaseTag = `v${releaseVersion}`;
  const omitSet = new Set(omit);
  const release = {
    tag_name: releaseTag,
    published_at: "2026-05-27T00:00:00Z",
    body: "Fixture release",
    prerelease,
    draft,
    assets: [],
  };
  for (const name of namesFor(releaseVersion)) {
    if (omitSet.has(name)) continue;
    const asset = {
      name,
      url: `https://api.github.com/repos/fiorix/chan/releases/assets/${encodeURIComponent(name)}`,
      browser_download_url: `https://github.com/fiorix/chan/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
    };
    if (name.endsWith(".sig")) {
      writeFileSync(path.join(assetDir, name), "fixture-updater-signature\n");
    } else {
      asset.digest = `sha256:${digestFor(releaseTag, name)}`;
    }
    release.assets.push(asset);
  }
  return release;
}

// Runs the collector against a --release-json fixture: a single release
// entry yields the single-object form (the requested release), an array the
// releases-list form. Returns { manifestPath, manifests }.
function runFixtureCollect(label, fixture, { latestCount = 0, tag = "" } = {}) {
  const { args, manifestPath } = prepareFixtureCollect(label, fixture, { latestCount, tag });
  execFileSync("node", args, { cwd: siteRoot });
  return { manifestPath, manifests: JSON.parse(readFileSync(manifestPath, "utf8")) };
}

function runFixtureCollectExpectFail(label, fixture, options = {}) {
  const { args } = prepareFixtureCollect(label, fixture, options);
  try {
    execFileSync("node", args, { cwd: siteRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return String(err.stderr || err.message);
  }
  throw new Error("collect-release-assets.mjs should have failed");
}

function prepareFixtureCollect(label, fixture, { latestCount = 0, tag = "" } = {}) {
  const runRoot = path.join(root, label);
  const assetDir = path.join(runRoot, "assets");
  mkdirSync(assetDir, { recursive: true });
  const entries = Array.isArray(fixture) ? fixture : [fixture];
  const releases = entries.map((entry) => buildReleaseObject(entry, assetDir));
  const releaseJson = path.join(runRoot, "release.json");
  writeFileSync(
    releaseJson,
    `${JSON.stringify(Array.isArray(fixture) ? releases : releases[0], null, 2)}\n`,
  );
  const manifestPath = path.join(runRoot, "manifest.json");
  const args = [
    "scripts/collect-release-assets.mjs",
    "--release-json",
    releaseJson,
    "--asset-dir",
    assetDir,
    "--out",
    manifestPath,
  ];
  if (latestCount > 0) args.push("--latest-count", String(latestCount));
  if (tag) args.push("--tag", tag);
  return { args, manifestPath };
}

function digestFor(releaseTag, name) {
  return createHash("sha256").update(`digest for ${releaseTag}/${name}`).digest("hex");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
