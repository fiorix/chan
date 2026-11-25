// @vitest-environment node
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI } from "./ghosttyVt";

/// The vendored core, its signature and the README whose table records
/// them (vitest runs in the package directory). The other tests read
/// whatever core is in the tree; this one ties that core to the release
/// the table names, so a table left stale or a wrong or damaged file fails.
const WASM = "vendor/ghostty-vt/ghostty-vt.wasm";
const MINISIG = "vendor/ghostty-vt/ghostty-vt.wasm.minisig";
const README = "vendor/ghostty-vt/README.md";

/// The DER prefix of an Ed25519 public key's SubjectPublicKeyInfo; the 32
/// key bytes follow it.
const ED25519_SPKI = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);

const wasm = readFileSync(WASM);
const readme = readFileSync(README, "utf8");

function base64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/// A row of the README's table, by its field name.
function row(field: string): string {
  for (const line of readme.split("\n")) {
    const cells = /^\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/.exec(line);
    if (cells?.[1] === field) return cells[2];
  }
  throw new Error(`the README's table has no ${field} row`);
}

/// The code spans of a table value, where its names and hashes are.
function codeSpans(value: string): string[] {
  return Array.from(value.matchAll(/`([^`]+)`/g), (m) => m[1]);
}

type Minisig = {
  algorithm: string;
  keyId: Uint8Array;
  signature: Uint8Array;
  trusted: string;
  fields: Map<string, string>;
  global: Uint8Array;
};

/// A minisign signature file: the algorithm, key id and signature of the
/// file, the trusted comment and its fields, and the global signature over
/// the file's signature and the trusted comment.
function minisig(text: string): Minisig {
  const lines = text.split("\n");
  expect(lines[0], "the untrusted comment line").toMatch(/^untrusted comment: /);
  expect(lines[2], "the trusted comment line").toMatch(/^trusted comment: /);
  const sig = base64(lines[1]);
  const trusted = lines[2].slice("trusted comment: ".length);
  const fields = new Map(
    trusted.split("\t").map((field) => {
      const colon = field.indexOf(":");
      return colon < 0 ? [field, ""] : [field.slice(0, colon), field.slice(colon + 1)];
    }),
  );
  return {
    algorithm: latin1(sig.subarray(0, 2)),
    keyId: sig.subarray(2, 10),
    signature: sig.subarray(10),
    trusted,
    fields,
    global: base64(lines[3]),
  };
}

const sig = minisig(readFileSync(MINISIG, "utf8"));

type TypeJson = {
  types: Record<string, { values?: Record<string, number>; fields?: Record<string, { offset: number }> }>;
};

/// What the core says of itself: its version string and its optimize mode,
/// asked through `ghostty_build_info` with the selector numbers and the
/// string layout its own `ghostty_type_json()` gives.
function buildInfo(instance: WebAssembly.Instance): { version: string; optimize: string | undefined } {
  const exports = instance.exports as Record<string, unknown>;
  const call = (name: string, ...args: number[]) => (exports[name] as (...a: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  const cString = (ptr: number) => {
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr;
    while (bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  };
  const json = JSON.parse(cString(call("ghostty_type_json"))) as TypeJson;
  const selector = json.types.GhosttyBuildInfo?.values ?? {};
  const modes = json.types.GhosttyOptimizeMode?.values ?? {};
  const string = json.types.GhosttyString?.fields ?? {};
  expect(Object.keys(selector), "the build info selectors").toEqual(expect.arrayContaining(["VERSION_STRING", "OPTIMIZE"]));
  expect(Object.keys(string), "the string layout").toEqual(expect.arrayContaining(["ptr", "len"]));
  const out = call("ghostty_wasm_alloc", 16);
  expect(call("ghostty_build_info", selector.VERSION_STRING, out), "VERSION_STRING").toBe(ABI.GhosttyResult.SUCCESS);
  const view = new DataView(memory.buffer);
  const ptr = view.getUint32(out + string.ptr.offset, true);
  const len = view.getUint32(out + string.len.offset, true);
  const version = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
  expect(call("ghostty_build_info", selector.OPTIMIZE, out), "OPTIMIZE").toBe(ABI.GhosttyResult.SUCCESS);
  const mode = new DataView(memory.buffer).getInt32(out, true);
  return { version, optimize: Object.entries(modes).find(([, value]) => value === mode)?.[0] };
}

describe("the vendored core is the release its README records", () => {
  let info: { version: string; optimize: string | undefined };

  beforeAll(async () => {
    info = buildInfo((await WebAssembly.instantiate(wasm, {})).instance);
  });

  test("its SHA-256 and size are the table's", () => {
    expect(codeSpans(row("SHA-256"))).toEqual([createHash("sha256").update(wasm).digest("hex")]);
    expect(row("Size")).toBe(`${wasm.length.toLocaleString("en-US")} bytes`);
  });

  test("its version is the one the Source, URL and Tag rows and the signature's file name give", () => {
    const v = info.version;
    expect(v, "the build's version string").toMatch(/^\d+\.\d+\.\d+/);
    expect(codeSpans(row("Source"))).toEqual([`ghostty-vt-${v}.wasm`]);
    expect(codeSpans(row("URL"))).toEqual([`https://release.files.ghostty.org/libghostty-vt/${v}/`]);
    expect(codeSpans(row("Tag"))).toEqual([`vt-${v}`]);
    for (const field of ["Source", "URL", "Tag"]) {
      expect(row(field).split(v).join(""), `${field} names no other version`).not.toMatch(/\d+\.\d+\.\d+/);
    }
    expect(sig.fields.get("file"), "the trusted comment's file name").toBe(`ghostty-vt-${v}.wasm`);
  });

  test("the Signed row is the signature's timestamp", () => {
    const timestamp = Number(sig.fields.get("timestamp"));
    expect(Number.isInteger(timestamp), "the trusted comment's timestamp").toBe(true);
    const signed = new Date(timestamp * 1000).toISOString().replace(/\.000Z$/, "Z");
    expect(row("Signed").match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g)).toEqual([signed]);
  });

  test("the Build row is its optimize mode", () => {
    expect(info.optimize, "the build's optimize mode").toBeDefined();
    const name = info.optimize!.split("_").map((word) => word[0] + word.slice(1).toLowerCase()).join("");
    expect(row("Build")).toBe(name);
  });

  test("its signature verifies with the README's key, and fails over a changed byte", () => {
    const keys = new Set(readme.match(/\bRW[A-Za-z0-9+/]{54}(?![A-Za-z0-9+/=])/g));
    expect(keys.size, "the README names one minisign key").toBe(1);
    const pk = base64([...keys][0]);
    expect(latin1(pk.subarray(0, 2)), "an Ed25519 minisign key").toBe("Ed");
    expect(sig.algorithm, "a signature over the file's BLAKE2b-512").toBe("ED");
    expect(hex(sig.keyId), "signed by that key").toBe(hex(pk.subarray(2, 10)));
    const key: KeyObject = createPublicKey({ key: concat(ED25519_SPKI, pk.subarray(10)), format: "der", type: "spki" });
    const signs = (file: Uint8Array) => verify(null, createHash("blake2b512").update(file).digest(), key, sig.signature);
    const comments = (trusted: string) => verify(null, concat(sig.signature, new TextEncoder().encode(trusted)), key, sig.global);
    expect(signs(wasm), "the file signature").toBe(true);
    expect(comments(sig.trusted), "the trusted comment's signature").toBe(true);
    const changed = wasm.slice();
    changed[changed.length >> 1] ^= 1;
    expect(signs(changed), "a changed byte fails").toBe(false);
    expect(comments(`${sig.trusted} `), "a changed comment fails").toBe(false);
  });
});
