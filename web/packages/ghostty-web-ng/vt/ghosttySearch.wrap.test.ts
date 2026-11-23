import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { ABI, GhosttyVt, LAYOUT, type MatchRange, type VtSearch, type VtTerminal } from "./ghosttyVt";

let module: WebAssembly.Module;
beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
});

const cases = [
  {
    name: "needle split at the wrap",
    first: "x".repeat(37) + "needle\r\n",
    needle: "needle",
    expected: { startRow: 0, startCol: 37, endRow: 1, endCol: 2 },
  },
  {
    name: "needle ending at the last column",
    first: "x".repeat(34) + "needleX\r\n",
    needle: "needle",
    expected: { startRow: 0, startCol: 34, endRow: 0, endCol: 39 },
  },
  {
    name: "wide character before a split needle",
    first: "x".repeat(37) + "\u754cneedle\r\n",
    needle: "needle",
    expected: { startRow: 0, startCol: 39, endRow: 1, endCol: 4 },
  },
  {
    name: "wide character moved past the last column",
    first: "x".repeat(39) + "\u754cneedle\r\n",
    needle: "\u754cneedle",
    expected: { startRow: 1, startCol: 0, endRow: 1, endCol: 7 },
  },
  {
    name: "needle inside the first row of a wrapped line",
    first: "needle" + "x".repeat(35) + "\r\n",
    needle: "needle",
    expected: { startRow: 0, startCol: 0, endRow: 0, endCol: 5 },
  },
  {
    name: "needle inside the second row of a wrapped line",
    first: "x".repeat(40) + "needle\r\n",
    needle: "needle",
    expected: { startRow: 1, startCol: 0, endRow: 1, endCol: 5 },
  },
];

type Matches = { total: number; matches: MatchRange[] };
type Observation = { core: Matches; binding: Matches };
type Raw = {
  handle: number;
  wasm: {
    fn: Record<string, (...args: number[]) => number>;
    view(): DataView;
    alloc(len: number): number;
    free(ptr: number, len: number): void;
  };
};
const raw = (value: unknown): Raw => value as Raw;

function check(result: number): void {
  if (result !== ABI.GhosttyResult.SUCCESS) throw new Error(`core result ${result}`);
}

// Drive and read the core directly so binding iteration cannot create the duplicate.
function coreMatches(t: VtTerminal, s: VtSearch): Matches {
  const { wasm, handle } = raw(s);
  const scratch = wasm.alloc(24);
  let array = 0;
  let bytes = 0;
  try {
    for (let i = 0; ; i++) {
      if (i === 100_000) throw new Error("the core scan did not complete");
      check(wasm.fn.ghostty_search_get(handle, ABI.GhosttySearchData.STATUS, scratch));
      const status = wasm.view().getUint32(scratch, true);
      if (status === ABI.GhosttySearchStatus.COMPLETE) break;
      check(status === ABI.GhosttySearchStatus.FEED_REQUIRED
        ? wasm.fn.ghostty_search_feed(handle)
        : wasm.fn.ghostty_search_tick(handle, 0));
    }
    check(wasm.fn.ghostty_search_get(handle, ABI.GhosttySearchData.TOTAL_MATCHES, scratch));
    const total = wasm.view().getUint32(scratch, true);
    const B = LAYOUT.GhosttySelectionBuffer.fields;
    const S = LAYOUT.GhosttySelection;
    bytes = total * S.size;
    array = wasm.alloc(bytes);
    wasm.view().setUint32(scratch + B.ptr, array, true);
    wasm.view().setUint32(scratch + B.cap, total, true);
    wasm.view().setUint32(scratch + B.len, 0, true);
    check(wasm.fn.ghostty_search_get(handle, ABI.GhosttySearchData.MATCHES, scratch));
    const length = wasm.view().getUint32(scratch + B.len, true);
    const point = (ref: number) => {
      check(wasm.fn.ghostty_terminal_point_from_grid_ref(raw(t).handle, ref, ABI.GhosttyPointTag.SCREEN, scratch + 16));
      const C = LAYOUT.GhosttyPointCoordinate.fields;
      return {
        row: wasm.view().getUint32(scratch + 16 + C.y, true),
        col: wasm.view().getUint16(scratch + 16 + C.x, true),
      };
    };
    const matches = Array.from({ length }, (_, i) => {
      const start = point(array + i * S.size + S.fields.start);
      const end = point(array + i * S.size + S.fields.end);
      return { startRow: start.row, startCol: start.col, endRow: end.row, endCol: end.col };
    });
    return { total, matches };
  } finally {
    if (array) wasm.free(array, bytes);
    wasm.free(scratch, 24);
  }
}

async function observe(stream: string, needle: string): Promise<Observation> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const t = vt.createTerminal(40, 2, { scrollbackLimit: 2000 });
  let s: VtSearch | undefined;
  try {
    t.write(stream);
    s = t.createSearch();
    s.setNeedle(needle);
    const core = coreMatches(t, s);
    const binding = { total: s.state().total, matches: s.matchesBetween(0, 2000, 3) };
    return { core, binding };
  } finally {
    s?.free();
    t.free();
  }
}

const controls = [
  { name: "no later wrap", suffix: "" },
  { name: "hard break at the later boundary", suffix: "\n".repeat(1130) + "x".repeat(40) + "\r\n" },
  { name: "later wrap one row earlier", suffix: "\n".repeat(1129) + "x".repeat(41) + "\r\n" },
  { name: "later wrap one row later", suffix: "\n".repeat(1131) + "x".repeat(41) + "\r\n" },
];

describe.each(cases)("soft-wrap search: $name", ({ first, needle, expected }) => {
  let boundary: Observation;
  const readings = new Map<string, Observation>();

  beforeAll(async () => {
    // The first line occupies rows 0 and 1. The later wrap crosses rows 1132/1133.
    boundary = await observe(first + "\n".repeat(1130) + "x".repeat(41) + "\r\n", needle);
    for (const control of controls) readings.set(control.name, await observe(first + control.suffix, needle));
  });

  test("the core reports two identical cell ranges before binding iteration", () => {
    expect(boundary.core).toEqual({ total: 2, matches: [expected, expected] });
    expect(boundary.binding).toEqual(boundary.core);
  });

  // The widget owner deduplicates these raw ranges; lib/search.test.ts
  // drives the same bytes through count, navigation and highlights.

  test.each(controls)("one occurrence has one match with $name", ({ name }) => {
    const correct = { total: 1, matches: [expected] };
    expect(readings.get(name)).toEqual({ core: correct, binding: correct });
  });
});
