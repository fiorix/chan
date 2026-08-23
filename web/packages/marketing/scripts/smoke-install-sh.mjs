#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const siteRoot = path.resolve(path.dirname(scriptPath), "..");
const installer = path.join(siteRoot, "src", "install.sh");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chan-install-smoke-"));
  try {
    const fakeBin = path.join(root, "bin");
    const assets = path.join(root, "assets");
    const prefixes = path.join(root, "prefixes");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(assets, { recursive: true });
    await fs.mkdir(prefixes, { recursive: true });
    await writeFakeUname(fakeBin);

    const linuxTar = await makeTarball(assets, "x86_64-unknown-linux-musl", "linux");
    const macTar = await makeTarball(assets, "aarch64-apple-darwin", "mac");
    const freebsdTar = await makeTarball(assets, "x86_64-unknown-freebsd", "freebsd");
    const metadataPath = path.join(root, "latest.json");
    const metadata = JSON.stringify(
        {
          version: "0.14.0",
          tag: "v0.14.0",
          published_at: "2026-05-27T00:00:00Z",
          targets: [
            {
              target: "x86_64-unknown-linux-musl",
              asset: "chan-x86_64-unknown-linux-musl.tar.gz",
              url: pathToFileURL(linuxTar.path).href,
              sha256: linuxTar.sha256,
            },
            {
              target: "aarch64-apple-darwin",
              asset: "chan-aarch64-apple-darwin.tar.gz",
              url: pathToFileURL(macTar.path).href,
              sha256: macTar.sha256,
            },
            {
              target: "x86_64-unknown-freebsd",
              asset: "chan-x86_64-unknown-freebsd.tar.gz",
              url: pathToFileURL(freebsdTar.path).href,
              sha256: freebsdTar.sha256,
            },
          ],
        },
        null,
        2,
    );
    await fs.writeFile(metadataPath, metadata);
    // The pinned-version path derives `$BASE/v$VERSION.json`, so the same
    // metadata is published under the version-pinned name too.
    await fs.writeFile(path.join(root, "v0.14.0.json"), metadata);

    runInstall({
      fakeBin,
      metadataPath,
      prefix: path.join(prefixes, "linux"),
      unameS: "Linux",
      unameM: "x86_64",
      expected: "linux",
    });
    runInstall({
      fakeBin,
      metadataPath,
      prefix: path.join(prefixes, "mac"),
      unameS: "Darwin",
      unameM: "arm64",
      expected: "mac",
    });
    runInstall({
      fakeBin,
      metadataPath,
      prefix: path.join(prefixes, "freebsd"),
      unameS: "FreeBSD",
      unameM: "amd64",
      expected: "freebsd",
    });
    runFreebsdArm64Refusal({
      fakeBin,
      metadataPath,
      prefix: path.join(prefixes, "freebsd-arm64"),
    });
    await runFetchFallback({
      freebsdTar,
      metadata,
      prefix: path.join(prefixes, "freebsd-fetch"),
      root,
    });
    runMetadataFailureFallback({
      fakeBin,
      metadataPath: path.join(root, "missing.json"),
      prefix: path.join(prefixes, "missing"),
    });
    runVersionPinChecks({ fakeBin, base: root, prefixes });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("smoked install.sh metadata selection and VERSION pinning");
}

async function writeFakeUname(fakeBin) {
  const uname = path.join(fakeBin, "uname");
  await fs.writeFile(
    uname,
    `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$FAKE_UNAME_S" ;;
  -m) printf '%s\\n' "$FAKE_UNAME_M" ;;
  *) printf '%s\\n' "$FAKE_UNAME_S" ;;
esac
`,
  );
  await fs.chmod(uname, 0o755);
}

async function makeTarball(assets, target, marker) {
  const staging = path.join(assets, `staging-${target}`);
  await fs.mkdir(staging, { recursive: true });
  const bin = path.join(staging, "chan");
  await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${marker}'\n`);
  await fs.chmod(bin, 0o755);

  const tarball = path.join(assets, `chan-${target}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", staging, "."]);
  const bytes = await fs.readFile(tarball);
  return {
    path: tarball,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function runInstall({
  fakeBin,
  metadataPath,
  prefix,
  unameS,
  unameM,
  expected,
  extraEnv = {},
  pathEnv = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
}) {
  const result = spawnSync("sh", [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_UNAME_S: unameS,
      FAKE_UNAME_M: unameM,
      METADATA_URL: metadataPath,
      PATH: pathEnv,
      PREFIX: prefix,
    },
  });
  if (result.status !== 0) {
    throw new Error(`install failed for ${unameS}/${unameM}: ${result.stderr || result.stdout}`);
  }
  const output = execFileSync(path.join(prefix, "bin", "chan"), { encoding: "utf8" }).trim();
  if (output !== expected) {
    throw new Error(`installed binary printed ${JSON.stringify(output)}, expected ${expected}`);
  }
}

function runFreebsdArm64Refusal({ fakeBin, metadataPath, prefix }) {
  const result = spawnSync("sh", [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_UNAME_S: "FreeBSD",
      FAKE_UNAME_M: "arm64",
      METADATA_URL: metadataPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      PREFIX: prefix,
    },
  });
  if (result.status === 0) {
    throw new Error("install unexpectedly accepted FreeBSD arm64");
  }
  const expected = "FreeBSD on arm64 is not published. amd64 only for now.";
  if (!result.stderr.includes(expected)) {
    throw new Error(`FreeBSD arm64 refusal not found: ${result.stderr}`);
  }
}

async function runFetchFallback({ freebsdTar, metadata, prefix, root }) {
  const fetchBin = path.join(root, "fetch-only-bin");
  const fetchRoot = path.join(root, "fetch-only-assets");
  await fs.mkdir(fetchBin, { recursive: true });
  await fs.mkdir(fetchRoot, { recursive: true });
  await writeFakeUname(fetchBin);

  // Isolate PATH from host curl/wget while retaining only the POSIX tools the
  // installer itself needs. The fake fetch then proves both HTTP downloads
  // use the base-system fallback.
  const tools = [
    "awk",
    "cp",
    "find",
    "gzip",
    "head",
    "install",
    "ln",
    "mkdir",
    "mktemp",
    "rm",
    "sed",
    "sh",
    "sha256sum",
    "tar",
    "tr",
  ];
  for (const tool of tools) {
    const resolved = execFileSync(
      "/bin/sh",
      ["-c", 'command -v "$1"', "chan-install-smoke", tool],
      { encoding: "utf8" },
    ).trim();
    await fs.symlink(resolved, path.join(fetchBin, tool));
  }
  const fetch = path.join(fetchBin, "fetch");
  await fs.writeFile(
    fetch,
    `#!/bin/sh
[ "$1" = "-qo" ] || exit 64
out=$2
url=$3
cp "$FAKE_FETCH_ROOT/\${url##*/}" "$out"
`,
  );
  await fs.chmod(fetch, 0o755);

  const tarName = path.basename(freebsdTar.path);
  await fs.copyFile(freebsdTar.path, path.join(fetchRoot, tarName));
  const remoteMetadata = metadata.replace(
    pathToFileURL(freebsdTar.path).href,
    `https://downloads.invalid/${tarName}`,
  );
  await fs.writeFile(path.join(fetchRoot, "latest.json"), remoteMetadata);

  runInstall({
    fakeBin: fetchBin,
    metadataPath: "https://downloads.invalid/latest.json",
    prefix,
    unameS: "FreeBSD",
    unameM: "amd64",
    expected: "freebsd",
    extraEnv: { FAKE_FETCH_ROOT: fetchRoot },
    pathEnv: fetchBin,
  });
}

function runMetadataFailureFallback({ fakeBin, metadataPath, prefix }) {
  const result = spawnSync("sh", [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_UNAME_S: "Linux",
      FAKE_UNAME_M: "x86_64",
      METADATA_URL: metadataPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      PREFIX: prefix,
    },
  });
  if (result.status === 0) {
    throw new Error("install unexpectedly succeeded with missing metadata");
  }
  if (!result.stderr.includes("manual downloads: https://github.com/fiorix/chan/releases")) {
    throw new Error(`missing metadata fallback message not found: ${result.stderr}`);
  }
}

// `validate_version` is written for the `#!/bin/sh` shebang, so it has to hold
// under whatever /bin/sh is. It once used the bash-only `[^...]` glob
// negation, which dash (the /bin/sh of Debian and Ubuntu, and the shell the
// documented `curl ... | sh` line runs) reads as a literal set: the test
// inverted, refusing every real version and passing garbage. So the matrix
// runs under every POSIX shell on this machine, not just the default one.
const VALID_VERSIONS = ["0.14.0", "1.2.3", "10.20.30"];
const INVALID_VERSIONS = ["abc", "v1.2.3", "1.2.3.4", "1.2", "1.2.x", "0.72.0-rc1"];
const VERSION_REJECTED = "VERSION must be a bare X.Y.Z version.";

function posixShells() {
  const candidates = [
    ["sh", ["sh"]],
    ["dash", ["dash"]],
    ["busybox ash", ["busybox", "sh"]],
    ["bash", ["bash"]],
  ];
  return candidates.filter(([, argv]) => {
    const probe = spawnSync(argv[0], [...argv.slice(1), "-c", "exit 0"], { encoding: "utf8" });
    return probe.status === 0;
  });
}

function runVersionPinChecks({ fakeBin, base, prefixes }) {
  const shells = posixShells();
  // `sh` is always present, so an empty list means the probe itself broke.
  if (!shells.some(([name]) => name === "sh")) {
    throw new Error("no working /bin/sh found to run the VERSION matrix under");
  }
  for (const [shellName, argv] of shells) {
    const run = (version, prefix) =>
      spawnSync(argv[0], [...argv.slice(1), installer], {
        encoding: "utf8",
        env: {
          ...process.env,
          BASE: base,
          FAKE_UNAME_S: "Linux",
          FAKE_UNAME_M: "x86_64",
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          PREFIX: prefix,
          VERSION: version,
        },
      });

    // A pinned version that exists installs end to end. This is the case the
    // `[^...]` glob broke: under dash it failed before any download.
    const prefix = path.join(prefixes, `pin-${shellName.replace(/\W+/g, "-")}`);
    const pinned = run("0.14.0", prefix);
    if (pinned.status !== 0) {
      throw new Error(
        `VERSION=0.14.0 install failed under ${shellName}: ${pinned.stderr || pinned.stdout}`,
      );
    }
    const output = execFileSync(path.join(prefix, "bin", "chan"), { encoding: "utf8" }).trim();
    if (output !== "linux") {
      throw new Error(
        `VERSION=0.14.0 under ${shellName} installed a binary printing ${JSON.stringify(output)}`,
      );
    }

    // The rest never reach a download, so they are judged on whether the
    // version check is what stopped them.
    for (const version of VALID_VERSIONS) {
      const result = run(version, path.join(prefixes, "unused"));
      if (result.stderr.includes(VERSION_REJECTED)) {
        throw new Error(`${shellName} rejected valid VERSION=${version}`);
      }
    }
    for (const version of INVALID_VERSIONS) {
      const result = run(version, path.join(prefixes, "unused"));
      if (result.status === 0) {
        throw new Error(`${shellName} accepted invalid VERSION=${version}`);
      }
      if (!result.stderr.includes(VERSION_REJECTED)) {
        throw new Error(
          `${shellName} failed VERSION=${version} for the wrong reason: ${result.stderr}`,
        );
      }
    }
  }
  console.log(`checked VERSION pinning under: ${shells.map(([name]) => name).join(", ")}`);
}

main().catch((err) => {
  console.error(`install.sh smoke failed: ${err.message}`);
  process.exitCode = 1;
});
