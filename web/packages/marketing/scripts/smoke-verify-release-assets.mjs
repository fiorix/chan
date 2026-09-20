#!/usr/bin/env node

// Behavioural coverage for verify-release-assets.mjs, the one release-asset
// script that otherwise gets only `node --check` in the marketing gate and
// whose first real run is a GA. Two parts, both offline:
//
//  1. Drive the verifier against --release-json fixtures: complete GA and RC
//     releases exit 0, while missing and wrong-version assets exit non-zero
//     naming the required published asset.
//  2. A workflow-coverage lint: every required asset whose exact filename
//     appears literally in a release.yml staging step must still be present, so
//     deleting or renaming that staging line reddens here without a real
//     release.
//
// The end-to-end path -- a verifier failure actually failing publish-release on
// a live tag -- needs a real GA run and is the owner's to observe.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requiredAssets } from "./release-assets.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..", "..", "..");
const verifyScript = "scripts/verify-release-assets.mjs";
const version = "9.9.9";
const tag = `v${version}`;
const prereleaseTag = "v9.9.9-rc1";
const windowsZip = "chan-x86_64-pc-windows-msvc.zip";
const publishedPrereleaseGateway = "chan-gateway-admin_9.9.9.rc1-1_amd64.deb";
// Literal names reported by a published RC. In particular, the ten gateway
// debs use GitHub's dot spelling; this fixture must not derive that boundary
// from the manifest helper the verifier consumes.
const publishedPrereleaseAssets = [
  "chan-x86_64-unknown-linux-musl.tar.gz",
  "chan-aarch64-unknown-linux-musl.tar.gz",
  "chan-aarch64-apple-darwin.tar.gz",
  "chan-x86_64-unknown-freebsd.tar.gz",
  "chan-aarch64-unknown-freebsd.tar.gz",
  "Chan_9.9.9-rc1.dmg",
  "Chan_9.9.9-rc1_amd64.AppImage",
  "Chan_9.9.9-rc1_aarch64.AppImage",
  "chan-gateway-profile_9.9.9.rc1-1_amd64.deb",
  "chan-gateway-profile_9.9.9.rc1-1_arm64.deb",
  "chan-gateway-identity_9.9.9.rc1-1_amd64.deb",
  "chan-gateway-identity_9.9.9.rc1-1_arm64.deb",
  "chan-gateway-devserver-proxy_9.9.9.rc1-1_amd64.deb",
  "chan-gateway-devserver-proxy_9.9.9.rc1-1_arm64.deb",
  "chan-gateway-devserver-control_9.9.9.rc1-1_amd64.deb",
  "chan-gateway-devserver-control_9.9.9.rc1-1_arm64.deb",
  publishedPrereleaseGateway,
  "chan-gateway-admin_9.9.9.rc1-1_arm64.deb",
  "Chan_9.9.9-rc1_x64-setup.exe",
  "chan-x86_64-pc-windows-msvc.zip",
  "Chan_9.9.9-rc1_aarch64.app.tar.gz",
  "Chan_9.9.9-rc1_aarch64.app.tar.gz.sig",
  "Chan_9.9.9-rc1_amd64.AppImage.sig",
  "Chan_9.9.9-rc1_aarch64.AppImage.sig",
  "Chan_9.9.9-rc1_x64-setup.exe.sig",
];
const freebsdTarballs = [
  "chan-x86_64-unknown-freebsd.tar.gz",
  "chan-aarch64-unknown-freebsd.tar.gz",
];

const root = mkdtempSync(path.join(tmpdir(), "chan-verify-release-"));
try {
  const v096Assets = requiredAssets("0.96.0");
  assertEqual(v096Assets.length, 25, "v0.96.0 required asset count");
  for (const tarball of freebsdTarballs) {
    assert(v096Assets.includes(tarball), `FreeBSD tarball is required: ${tarball}`);
  }

  // 1. A complete fixture release verifies clean.
  const complete = runVerify("complete", requiredAssets(version));
  assertEqual(complete.status, 0, "complete release exits 0");

  const publishedPrerelease = runVerify(
    "published-prerelease",
    publishedPrereleaseAssets,
    prereleaseTag,
  );
  assertEqual(publishedPrerelease.status, 0, "complete published RC exits 0");

  const withoutPrereleaseGateway = publishedPrereleaseAssets.filter(
    (name) => name !== publishedPrereleaseGateway,
  );
  const missingPrereleaseGateway = runVerify(
    "missing-prerelease-gateway",
    withoutPrereleaseGateway,
    prereleaseTag,
  );
  assertEqual(missingPrereleaseGateway.status, 1, "published RC missing a gateway exits non-zero");
  assert(
    missingPrereleaseGateway.stderr.includes(
      `missing release asset: ${publishedPrereleaseGateway}`,
    ),
    `error names the missing published gateway (stderr: ${missingPrereleaseGateway.stderr})`,
  );

  const wrongVersionPrereleaseGateway = publishedPrereleaseAssets.map((name) =>
    name === publishedPrereleaseGateway
      ? "chan-gateway-admin_9.9.8.rc1-1_amd64.deb"
      : name,
  );
  const wrongPrereleaseGateway = runVerify(
    "wrong-version-prerelease-gateway",
    wrongVersionPrereleaseGateway,
    prereleaseTag,
  );
  assertEqual(wrongPrereleaseGateway.status, 1, "published RC with a wrong gateway version exits non-zero");
  assert(
    wrongPrereleaseGateway.stderr.includes(
      `missing release asset: ${publishedPrereleaseGateway}`,
    ),
    `wrong-version error names the required published gateway (stderr: ${wrongPrereleaseGateway.stderr})`,
  );

  // A release missing the Windows CLI zip is rejected, naming the file. This is
  // the check that would have caught the silent Windows gap.
  const withoutZip = requiredAssets(version).filter((name) => name !== windowsZip);
  const missing = runVerify("missing-windows", withoutZip);
  assertEqual(missing.status, 1, "missing Windows zip exits non-zero");
  assert(
    missing.stderr.includes(`missing release asset: ${windowsZip}`),
    `error names the missing Windows zip (stderr: ${missing.stderr})`,
  );

  // A release missing one updater signature is rejected, naming it: the
  // `.sig` requirement is what keeps a GA from shipping a payload the
  // updater cannot verify.
  const windowsSig = "Chan_9.9.9_x64-setup.exe.sig";
  const withoutSig = requiredAssets(version).filter((name) => name !== windowsSig);
  const missingSig = runVerify("missing-sig", withoutSig);
  assertEqual(missingSig.status, 1, "missing updater signature exits non-zero");
  assert(
    missingSig.stderr.includes(`missing release asset: ${windowsSig}`),
    `error names the missing signature (stderr: ${missingSig.stderr})`,
  );

  // 2. Workflow-coverage lint.
  lintWorkflowCoverage();

  console.log("smoked release asset verification");
} finally {
  rmSync(root, { force: true, recursive: true });
}

// Runs the verifier offline against a fixture release built from `names`.
// Returns { status, stderr }.
function runVerify(label, names, releaseTag = tag) {
  const releaseJson = path.join(root, `${label}.json`);
  const release = {
    tag_name: releaseTag,
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/fiorix/chan/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
    })),
  };
  writeFileSync(releaseJson, `${JSON.stringify(release, null, 2)}\n`);
  try {
    execFileSync(
      "node",
      [verifyScript, "--release-json", releaseJson, "--skip-asset-url-heads"],
      { cwd: siteRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stderr: String(err.stderr ?? err.message) };
  }
}

// Assert that every required name which appears LITERALLY in a release.yml
// staging step is still there, normalizing the version interpolation to a
// token. Names produced by matrix interpolation or glob upload never appear
// literally and are exempt by construction:
//   - the musl CLI tarballs are `chan-${MUSL_TARGET}.tar.gz` (matrix var);
//   - the Linux desktop AppImage and its detached updater signature upload
//     from the tauri bundle dir by `*.AppImage` / `*.AppImage.sig` glob;
//   - the gateway .debs are cargo-deb output uploaded by `*.deb` glob.
function lintWorkflowCoverage() {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  // Drop whole-line comments so a comment that merely names an asset (e.g. the
  // line above the Windows zip staging step) cannot stand in for the real
  // staging line: deleting the staging line must redden even if its doc comment
  // stays.
  const staging = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const normalizedWorkflow = normalizeVersion(staging, /\$\{(?:env:)?VERSION\}/g);
  const missing = [];
  for (const name of requiredAssets(version)) {
    if (isGlobUploaded(name)) continue;
    const normalizedName = normalizeVersion(name, new RegExp(escapeRegExp(version), "g"));
    if (!normalizedWorkflow.includes(normalizedName)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `release.yml no longer stages these required assets by name: ${missing.join(", ")}`,
    );
  }
}

function isGlobUploaded(name) {
  return (
    /-unknown-linux-musl\.tar\.gz$/.test(name) || // matrix ${MUSL_TARGET}
    /\.AppImage(\.sig)?$/.test(name) || // tauri bundle glob, payload + signature
    /^chan-gateway-.*\.deb$/.test(name) // cargo-deb glob
  );
}

function normalizeVersion(text, pattern) {
  return text.replace(pattern, "<VERSION>");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
