#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsRoot = path.dirname(scriptPath);
const siteRoot = path.resolve(scriptsRoot, "..");
const fixture = path.join(siteRoot, "fixtures", "release-assets", "v0.15.4.json");
const fixtureVersion = "0.15.4";
const prereleaseVersion = "0.56.0-rc1";

async function main() {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "chan-release-metadata-"));
  try {
    await runNode(path.join(scriptsRoot, "generate-release-metadata.mjs"), [
      "--manifest",
      fixture,
      "--out",
      out,
    ]);

    const releases = await readJson(path.join(out, "releases.json"));
    const cliLatest = await readJson(path.join(out, "cli", "latest.json"));
    const cliVersion = await readJson(path.join(out, "cli", "v0.15.4.json"));
    const desktopLatest = await readJson(path.join(out, "desktop", "latest.json"));
    const desktopVersion = await readJson(path.join(out, "desktop", "v0.15.4.json"));

    assert(releases.latest === "0.15.4", "releases.json latest version");
    assert(releases.latest_tag === "v0.15.4", "releases.json latest tag");
    assert(releases.releases?.[0]?.downloads?.length === 14, "release download count");
    const downloadIds = new Set(releases.releases[0].downloads.map((download) => download.id));
    assert(downloadIds.has("cli-linux-x64"), "CLI tarball download id present");
    assert(!downloadIds.has("desktop-linux-rpm-amd64"), "dropped desktop rpm download id absent");
    assert(downloadIds.has("gateway-profile-deb-amd64"), "gateway download id present");
    assert(cliLatest.version === "0.15.4", "CLI latest version");
    assert(JSON.stringify(cliLatest) === JSON.stringify(cliVersion), "CLI latest equals version file");
    assert(cliLatest.targets.length === 3, "CLI target count");
    assert(
      cliLatest.targets.every((target) => /^[a-f0-9]{64}$/.test(target.sha256)),
      "CLI sha256 values",
    );
    assert(desktopLatest.pub_date === "2026-05-27T00:00:00Z", "desktop pub_date");
    assert(
      JSON.stringify(desktopLatest) === JSON.stringify(desktopVersion),
      "desktop latest equals version file",
    );
    assert(
      desktopLatest.platforms["darwin-aarch64"]?.signature === "fixture-signature-darwin-aarch64",
      "desktop updater signature",
    );
    // The fixture ships no Windows assets, so the optional Windows downloads
    // stay out of the manifest (the install-page buttons fall back).
    assert(!downloadIds.has("desktop-windows-nsis"), "windows installer absent without asset");
    assert(!downloadIds.has("cli-windows-x64"), "windows cli absent without asset");

    // With the Windows assets present, the optional downloads light up.
    const withWindows = JSON.parse(await fs.readFile(fixture, "utf8"));
    const windowsNames = ["Chan_0.15.4_x64-setup.exe", "chan-x86_64-pc-windows-msvc.zip"];
    for (const name of windowsNames) {
      withWindows.assets.push({
        name,
        url: `https://github.com/fiorix/chan/releases/download/v0.15.4/${name}`,
        sha256: createHash("sha256").update(name).digest("hex"),
      });
    }
    const winManifest = path.join(out, "with-windows.json");
    await fs.writeFile(winManifest, `${JSON.stringify(withWindows)}\n`);
    const winOut = path.join(out, "win");
    await runNode(path.join(scriptsRoot, "generate-release-metadata.mjs"), [
      "--manifest",
      winManifest,
      "--out",
      winOut,
    ]);
    const winDownloads = (await readJson(path.join(winOut, "releases.json"))).releases[0].downloads;
    assert(winDownloads.length === 16, "windows present adds two downloads");
    const winById = new Map(winDownloads.map((download) => [download.id, download]));
    assert(winById.has("desktop-windows-nsis"), "windows installer download present");
    assert(winById.has("cli-windows-x64"), "windows cli download present");
    assert(
      winById.get("desktop-windows-nsis").url.endsWith("/Chan_0.15.4_x64-setup.exe"),
      "windows installer url",
    );
    assert(
      /^[a-f0-9]{64}$/.test(winById.get("cli-windows-x64").sha256),
      "windows cli sha256",
    );

    const prerelease = rewriteFixtureVersion(
      JSON.parse(await fs.readFile(fixture, "utf8")),
      prereleaseVersion,
    );
    const prereleaseManifest = path.join(out, "prerelease.json");
    await fs.writeFile(prereleaseManifest, `${JSON.stringify(prerelease)}\n`);
    const prereleaseOut = path.join(out, "prerelease");
    await runNode(path.join(scriptsRoot, "generate-release-metadata.mjs"), [
      "--manifest",
      prereleaseManifest,
      "--out",
      prereleaseOut,
    ]);
    const prereleaseReleases = await readJson(path.join(prereleaseOut, "releases.json"));
    const prereleaseCli = await readJson(
      path.join(prereleaseOut, "cli", `v${prereleaseVersion}.json`),
    );
    const prereleaseDownloads = prereleaseReleases.releases[0].downloads;
    assert(prereleaseReleases.latest === prereleaseVersion, "prerelease latest version");
    assert(prereleaseCli.version === prereleaseVersion, "prerelease CLI version");
    assert(
      prereleaseDownloads.some((download) => download.asset === "chan-gateway-admin_0.56.0.rc1-1_amd64.deb"),
      "prerelease gateway asset mapped",
    );
    assert(
      prereleaseDownloads.some((download) => download.asset === "Chan_0.56.0-rc1_amd64.AppImage"),
      "prerelease desktop asset mapped",
    );

    // History mode: an array of synthetic manifests (newest first) emits only
    // the retained window (default --latest-count 5).
    const historyVersions = ["0.16.0", "0.15.9", "0.15.8", "0.15.7", "0.15.6", "0.15.5"];
    const fixtureRaw = await fs.readFile(fixture, "utf8");
    const syntheticManifest = (historyVersion) =>
      rewriteFixtureVersion(JSON.parse(fixtureRaw), historyVersion);
    const historyManifest = path.join(out, "history.json");
    await fs.writeFile(
      historyManifest,
      `${JSON.stringify(historyVersions.map(syntheticManifest))}\n`,
    );
    const historyOut = path.join(out, "history");
    await runNode(path.join(scriptsRoot, "generate-release-metadata.mjs"), [
      "--manifest",
      historyManifest,
      "--out",
      historyOut,
    ]);

    const retained = historyVersions.slice(0, 5);
    const historyReleases = await readJson(path.join(historyOut, "releases.json"));
    assert(historyReleases.releases.length === 5, "releases.json retains 5 entries");
    assert(
      JSON.stringify(historyReleases.releases.map((entry) => entry.version)) ===
        JSON.stringify(retained),
      "releases.json entries newest-first",
    );
    assert(historyReleases.latest === "0.16.0", "history latest version");
    assert(historyReleases.latest_tag === "v0.16.0", "history latest tag");
    for (const [index, retainedVersion] of retained.entries()) {
      const retainedTag = `v${retainedVersion}`;
      const entry = historyReleases.releases[index];
      assert(entry.cli === `/dl/cli/${retainedTag}.json`, `entry cli path ${retainedTag}`);
      assert(
        entry.desktop === `/dl/desktop/${retainedTag}.json`,
        `entry desktop path ${retainedTag}`,
      );
      const cliVersioned = await readJson(path.join(historyOut, "cli", `${retainedTag}.json`));
      const desktopVersioned = await readJson(
        path.join(historyOut, "desktop", `${retainedTag}.json`),
      );
      assert(cliVersioned.version === retainedVersion, `cli ${retainedTag} version`);
      assert(cliVersioned.tag === retainedTag, `cli ${retainedTag} tag`);
      assert(desktopVersioned.version === retainedVersion, `desktop ${retainedTag} version`);
    }
    const historyCliLatest = await readJson(path.join(historyOut, "cli", "latest.json"));
    const historyCliNewest = await readJson(path.join(historyOut, "cli", "v0.16.0.json"));
    const historyDesktopLatest = await readJson(path.join(historyOut, "desktop", "latest.json"));
    const historyDesktopNewest = await readJson(
      path.join(historyOut, "desktop", "v0.16.0.json"),
    );
    assert(
      JSON.stringify(historyCliLatest) === JSON.stringify(historyCliNewest),
      "history cli latest equals newest version file",
    );
    assert(
      JSON.stringify(historyDesktopLatest) === JSON.stringify(historyDesktopNewest),
      "history desktop latest equals newest version file",
    );
    assert(
      !(await fileExists(path.join(historyOut, "cli", "v0.15.5.json"))),
      "oldest version outside the window has no cli file",
    );
    assert(
      !(await fileExists(path.join(historyOut, "desktop", "v0.15.5.json"))),
      "oldest version outside the window has no desktop file",
    );

    // A smaller explicit window retains fewer releases.
    const narrowOut = path.join(out, "narrow");
    await runNode(path.join(scriptsRoot, "generate-release-metadata.mjs"), [
      "--manifest",
      historyManifest,
      "--out",
      narrowOut,
      "--latest-count",
      "2",
    ]);
    const narrowReleases = await readJson(path.join(narrowOut, "releases.json"));
    assert(narrowReleases.releases.length === 2, "explicit --latest-count caps retention");
    assert(
      !(await fileExists(path.join(narrowOut, "cli", "v0.15.8.json"))),
      "narrow window drops older versions",
    );

    // Invalid histories are rejected: duplicate versions, a first entry that
    // is not the newest, and an empty array.
    const duplicateManifest = path.join(out, "duplicate.json");
    await fs.writeFile(
      duplicateManifest,
      `${JSON.stringify([syntheticManifest("0.16.0"), syntheticManifest("0.16.0")])}\n`,
    );
    const duplicateError = await runNodeExpectFail(
      path.join(scriptsRoot, "generate-release-metadata.mjs"),
      ["--manifest", duplicateManifest, "--out", path.join(out, "duplicate")],
    );
    assert(duplicateError.includes("duplicate"), "duplicate versions rejected");

    const unsortedManifest = path.join(out, "unsorted.json");
    await fs.writeFile(
      unsortedManifest,
      `${JSON.stringify([syntheticManifest("0.15.9"), syntheticManifest("0.16.0")])}\n`,
    );
    const unsortedError = await runNodeExpectFail(
      path.join(scriptsRoot, "generate-release-metadata.mjs"),
      ["--manifest", unsortedManifest, "--out", path.join(out, "unsorted")],
    );
    assert(unsortedError.includes("newest"), "first-not-newest rejected");

    // A middle-inverted array is rejected even when the first entry is the
    // newest: releases.json must always be newest-first.
    const invertedManifest = path.join(out, "inverted.json");
    await fs.writeFile(
      invertedManifest,
      `${JSON.stringify([
        syntheticManifest("0.16.0"),
        syntheticManifest("0.15.6"),
        syntheticManifest("0.15.8"),
      ])}\n`,
    );
    const invertedError = await runNodeExpectFail(
      path.join(scriptsRoot, "generate-release-metadata.mjs"),
      ["--manifest", invertedManifest, "--out", path.join(out, "inverted")],
    );
    assert(invertedError.includes("newest-first"), "middle-inverted history rejected");

    const emptyManifest = path.join(out, "empty.json");
    await fs.writeFile(emptyManifest, "[]\n");
    const emptyError = await runNodeExpectFail(
      path.join(scriptsRoot, "generate-release-metadata.mjs"),
      ["--manifest", emptyManifest, "--out", path.join(out, "empty")],
    );
    assert(emptyError.includes("empty"), "empty manifest array rejected");
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
  console.log("smoked release metadata generation");
}

function runNode(file, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${path.basename(file)} failed: ${stderr || stdout || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function runNodeExpectFail(file, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], (err, stdout, stderr) => {
      if (err) {
        resolve(stderr || stdout || err.message);
      } else {
        reject(new Error(`${path.basename(file)} should have failed`));
      }
    });
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

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function rewriteFixtureVersion(manifest, nextVersion) {
  const oldTag = manifest.tag;
  const nextTag = `v${nextVersion}`;
  manifest.version = nextVersion;
  manifest.tag = nextTag;
  manifest.assets = manifest.assets.map((asset) => {
    const name = rewriteAssetName(asset.name, nextVersion);
    return {
      ...asset,
      name,
      url: asset.url
        .replace(`/${oldTag}/`, `/${nextTag}/`)
        .replace(encodeURIComponent(asset.name), encodeURIComponent(name))
        .replace(asset.name, name),
    };
  });
  return manifest;
}

function rewriteAssetName(name, nextVersion) {
  const gatewayVersion = nextVersion.replace("-", ".");
  if (name.startsWith("chan-gateway-")) {
    return name.replace(`_${fixtureVersion}-1_`, `_${gatewayVersion}-1_`);
  }
  return name
    .replaceAll(`Chan_${fixtureVersion}`, `Chan_${nextVersion}`)
    .replaceAll(`Chan-${fixtureVersion}`, `Chan-${nextVersion}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

main().catch((err) => {
  console.error(`release metadata smoke failed: ${err.message}`);
  process.exitCode = 1;
});
