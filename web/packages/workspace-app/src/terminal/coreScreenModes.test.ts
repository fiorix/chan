// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI, GhosttyVt } from "@chan/ghostty-web-ng/vt";

import { FRESH_SHELL_RESET_MODES } from "./freshShellReset";

// The vendored terminal core's reading of the byte streams in
// `crates/chan-library/tests/fixtures/core-screen-modes.json`: for each case,
// whether a fresh core of 80 by 24 fed the case's chunks in order is on the
// alternate screen, and which of the server's tracked private modes are on;
// for each family, the one reading every one of its streams gives, whole or
// split in two at any byte, between the family's reads before and after it.
// `crates/chan-library/src/terminal_sessions/tests/alt_screen_tests.rs` holds
// the server's screen and mode tracker to the same readings, and
// `crates/chan-server/src/routes/terminal_streamlag_tests.rs` the redial
// tests' models, so the server, its tests and a view's core are compared on
// the same bytes.
//
// By default this file is the guard: it fails when a recorded reading is not
// the core's, naming the case, or the family with each stream and split the
// core reads otherwise, or when the fixture was recorded from another core.
// With CHAN_RECORD_CORE_MODES=1 it is the recorder: it rewrites each case's
// and each family's `core` and the `recorded` header in place, keeping the
// cases and families, their order and their input text, and fails when a
// family's streams do not all read alike. From the checkout root:
//
//   CHAN_RECORD_CORE_MODES=1 npm --prefix web run test -w @chan/workspace-app -- src/terminal/coreScreenModes.test.ts
//
// A new case or family is added with `"core": null` and recorded.

// Relative to the package directory vitest runs from.
const FIXTURE = "../../../crates/chan-library/tests/fixtures/core-screen-modes.json";
const WASM = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const RECORD = env.CHAN_RECORD_CORE_MODES === "1";
const RECORD_COMMAND =
  "CHAN_RECORD_CORE_MODES=1 npm --prefix web run test -w @chan/workspace-app -- src/terminal/coreScreenModes.test.ts";

type Reading = { alternate: boolean; modes: number[] };
type Case = { name: string; chunks: string[]; core: Reading | null };
type Family = { name: string; before: string[]; streams: string[]; after: string[]; core: Reading | null };
type Fixture = {
  recorded: { wasm: string; version: string; sha256: string; command: string; date: string };
  format: string;
  tracked: number[];
  cases: Case[];
  families: Family[];
};

// The server's tracked set; `TerminalTab.freshShellModes.test.ts` ties this
// list to it.
const TRACKED = [...FRESH_SHELL_RESET_MODES].sort((a, b) => a - b);

const wasm = readFileSync(WASM);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

let vendored: WebAssembly.Module;
let core: { version: string; sha256: string };

beforeAll(async () => {
  vendored = await WebAssembly.compile(wasm);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", wasm));
  core = {
    version: buildVersion(await WebAssembly.instantiate(vendored, {})),
    sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
});

/// The core's own version string, asked through `ghostty_build_info` with
/// the selector and the string layout its `ghostty_type_json()` gives.
function buildVersion(instance: WebAssembly.Instance): string {
  const exports = instance.exports as Record<string, unknown>;
  const call = (name: string, ...args: number[]) => (exports[name] as (...a: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  const start = call("ghostty_type_json");
  const bytes = new Uint8Array(memory.buffer);
  const types = (
    JSON.parse(new TextDecoder().decode(bytes.subarray(start, bytes.indexOf(0, start)))) as {
      types: Record<string, { values?: Record<string, number>; fields?: Record<string, { offset: number }> }>;
    }
  ).types;
  const selector = types.GhosttyBuildInfo?.values?.VERSION_STRING;
  const field = types.GhosttyString?.fields;
  if (selector === undefined || field?.ptr === undefined || field.len === undefined) {
    throw new Error("the core names no version string");
  }
  const out = call("ghostty_wasm_alloc", 16);
  if (call("ghostty_build_info", selector, out) !== ABI.GhosttyResult.SUCCESS) throw new Error("the core gave no version string");
  const view = new DataView(memory.buffer);
  const ptr = view.getUint32(out + field.ptr.offset, true);
  const len = view.getUint32(out + field.len.offset, true);
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

/// A chunk's bytes: each character is one byte.
function chunkBytes(name: string, chunk: string): Uint8Array {
  const codes = Array.from(chunk, (c) => c.codePointAt(0)!);
  const wide = codes.find((code) => code > 0xff);
  if (wide !== undefined) throw new Error(`${name}: U+${wide.toString(16)} is not a byte`);
  return Uint8Array.from(codes);
}

/// What a fresh core reads after `chunks`, written one call per chunk as a
/// view receives the session's reads.
function readChunks(vt: GhosttyVt, name: string, chunks: string[]): Reading {
  const term = vt.createTerminal(80, 24);
  try {
    for (const chunk of chunks) term.write(chunkBytes(name, chunk));
    return { alternate: term.isAlternateScreen(), modes: TRACKED.filter((mode) => term.getMode(mode)) };
  } finally {
    term.free();
  }
}

/// What a fresh core reads after `c`'s chunks.
async function read(c: Case): Promise<Reading> {
  return readChunks(new GhosttyVt(await WebAssembly.instantiate(vendored, {})), c.name, c.chunks);
}

/// `stream` in one read, then in two split at each character after its
/// first; each character is one byte.
function everySplit(stream: string): string[][] {
  return [[stream], ...Array.from({ length: stream.length - 1 }, (_, at) => [stream.slice(0, at + 1), stream.slice(at + 1)])];
}

/// Each stream of `f` and split of it the core reads otherwise than
/// `reading`, named, with the count of reads; a fresh terminal per read.
async function familyDifferences(f: Family, reading: Reading): Promise<{ reads: number; differ: string[] }> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const differ: string[] = [];
  let reads = 0;
  f.streams.forEach((stream, index) => {
    for (const split of everySplit(stream)) {
      reads += 1;
      const core = readChunks(vt, f.name, [...f.before, ...split, ...f.after]);
      if (JSON.stringify(core) !== JSON.stringify(reading)) {
        differ.push(`stream ${index} split after ${split[0]!.length} of ${stream.length}: ${JSON.stringify(core)}`);
      }
    }
  });
  return { reads, differ };
}

/// JSON with every character outside printable ASCII written as a `\u`
/// escape, the short escapes (`\r`, `\n`) included, so the file shows each
/// control byte by its number.
function json(value: unknown): string {
  return JSON.stringify(value).replace(/\\.|[^ -~]/g, (m) => {
    const code = m.length === 1 ? m.charCodeAt(0) : SHORT_ESCAPES[m[1]!];
    return code === undefined ? m : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

const SHORT_ESCAPES: Record<string, number> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09 };

/// The fixture as the recorder writes it: the header's fields one per line
/// and one case per line, so a reading that changes changes its case's line.
function serialize(f: Fixture): string {
  const header = Object.entries(f.recorded).map(([key, value]) => `    ${json(key)}: ${json(value)}`);
  const reading = (core: Reading | null) =>
    core === null ? "null" : `{"alternate": ${core.alternate}, "modes": [${core.modes.join(", ")}]}`;
  const strings = (values: string[]) => `[${values.map(json).join(", ")}]`;
  const cases = f.cases.map((c) => `    {"name": ${json(c.name)}, "chunks": ${strings(c.chunks)}, "core": ${reading(c.core)}}`);
  const families = f.families.map((family) =>
    `    {"name": ${json(family.name)}, "before": ${strings(family.before)}, "streams": ${strings(family.streams)}, ` +
    `"after": ${strings(family.after)}, "core": ${reading(family.core)}}`);
  return [
    "{",
    `  "recorded": {\n${header.join(",\n")}\n  },`,
    `  "format": ${json(f.format)},`,
    `  "tracked": [${f.tracked.join(", ")}],`,
    `  "cases": [\n${cases.join(",\n")}\n  ],`,
    `  "families": [\n${families.join(",\n")}\n  ]`,
    "}",
    "",
  ].join("\n");
}

describe.skipIf(RECORD)("the recorded readings are the vendored core's", () => {
  test("the fixture was recorded from the vendored core over the tracked modes", () => {
    expect(fixture.recorded.sha256, "the recorded core's SHA-256").toBe(core.sha256);
    expect(fixture.recorded.version, "the recorded core's version").toBe(core.version);
    expect(fixture.tracked, "the modes read").toEqual(TRACKED);
    expect(new Set(fixture.cases.map((c) => c.name)).size, "case names are unique").toBe(fixture.cases.length);
    expect(new Set(fixture.families.map((f) => f.name)).size, "family names are unique").toBe(fixture.families.length);
  });

  // The title is cut short in the report; the messages carry the whole name.
  test.for(fixture.cases)("$name", async (c) => {
    expect(c.core, `${c.name}: recorded`).not.toBeNull();
    expect(await read(c), c.name).toEqual(c.core);
  });

  test.for(fixture.families)("family: $name", async (f) => {
    expect(f.core, `${f.name}: recorded`).not.toBeNull();
    const { reads, differ } = await familyDifferences(f, f.core!);
    expect(reads, `${f.name}: reads`).toBeGreaterThan(0);
    expect(differ, `${f.name}: the streams and splits the core reads otherwise than ${JSON.stringify(f.core)}`).toEqual([]);
  });
});

describe.runIf(RECORD)("recording the core's readings", () => {
  test("records every case and the core it read them with", async () => {
    expect(fixture.cases.length, "cases to record").toBeGreaterThan(0);
    for (const c of fixture.cases) c.core = await read(c);
    for (const f of fixture.families) {
      const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
      const reading = readChunks(vt, f.name, [...f.before, f.streams[0]!, ...f.after]);
      const { differ } = await familyDifferences(f, reading);
      expect(differ, `${f.name}: a family's streams all read as its first does, ${JSON.stringify(reading)}`).toEqual([]);
      f.core = reading;
    }
    fixture.recorded = {
      wasm: "web/packages/ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm",
      version: core.version,
      sha256: core.sha256,
      command: RECORD_COMMAND,
      date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    };
    fixture.tracked = TRACKED;
    writeFileSync(FIXTURE, serialize(fixture));
  });
});
