#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(scriptsRoot, "..");
const installer = await fs.readFile(path.join(siteRoot, "src", "install.ps1"), "utf8");

for (const required of [
  '$DefaultMetadataBase = "https://chan.app/dl/cli"',
  '$Target = "x86_64-pc-windows-msvc"',
  '$ExpectedAsset = "chan-x86_64-pc-windows-msvc.zip"',
  'Join-Path $env:LOCALAPPDATA "chan-cli"',
  "Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256",
  "[System.IO.File]::Replace",
  "Registry::HKEY_CURRENT_USER",
  ":: chan-desktop",
  "PROCESSOR_ARCHITEW6432",
  "Windows ARM64 is not published",
  'set "ARGV0=cs"',
  "export ARGV0=cs",
  "[System.EnvironmentVariableTarget]::User",
]) {
  assert(installer.includes(required), `installer contract is missing ${JSON.stringify(required)}`);
}

for (const forbidden of [
  "CHAN_DESKTOP_HANDOFF=1",
  "x86_64-pc-windows-gnu",
  "releases/latest/download",
]) {
  assert(!installer.includes(forbidden), `installer contains forbidden ${JSON.stringify(forbidden)}`);
}

console.log("smoked Windows PowerShell installer contract");

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
