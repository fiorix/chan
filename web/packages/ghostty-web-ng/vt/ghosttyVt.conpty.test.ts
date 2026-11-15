import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { GhosttyVt, VtCells, type VtTerminal } from "./ghosttyVt";

let vendored: WebAssembly.Module;
const terminals = new Set<VtTerminal>();

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));
});

afterEach(() => {
  for (const terminal of terminals) terminal.free();
  terminals.clear();
});

async function instance(): Promise<GhosttyVt> {
  return new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
}

function terminal(vt: GhosttyVt): VtTerminal {
  const result = vt.createTerminal(20, 6);
  terminals.add(result);
  return result;
}

function free(term: VtTerminal): void {
  term.free();
  terminals.delete(term);
}

function row(term: VtTerminal, index: number, history = false): string {
  const cells = new VtCells();
  expect(history ? term.readHistoryRow(index, cells) : term.readRow(index, cells)).toBe(true);
  return Array.from({ length: cells.length }, (_, column) => {
    const cell = cells.at(column)!;
    return cell.width === 0 ? "" : cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ";
  }).join("").trimEnd();
}

function snapshot(term: VtTerminal) {
  term.beginFrame();
  const result = {
    screen: Array.from({ length: term.rows }, (_, index) => row(term, index)),
    history: Array.from({ length: term.getScrollbackLength() }, (_, index) => row(term, index, true)),
    cursor: term.getCursor(),
  };
  term.endFrame();
  return result;
}

const arms = [
  { name: "height", shortCols: 20, grownCols: 20 },
  { name: "corner", shortCols: 24, grownCols: 20 },
];

function shrinkWithHistory(term: VtTerminal, shortCols: number): ReturnType<typeof snapshot> {
  // Short generated lines never reflow; any moved row comes from height.
  term.write(Array.from({ length: 30 }, (_, index) => `row-${index}\r\n`).join("") + "prompt> ");
  term.resize(shortCols, 3);
  const before = snapshot(term);
  expect(before.history.length, "the resize has older rows available to pull").toBeGreaterThan(3);
  expect(before.screen.at(-1)).toBe("prompt>");
  expect(before.cursor.y).toBe(2);
  return before;
}

function grow(term: VtTerminal, cols: number, pull: boolean): void {
  const before = snapshot(term);
  term.resize(cols, 6);
  const after = snapshot(term);
  expect(after.cursor.x, "growing preserves the prompt column").toBe(before.cursor.x);
  if (pull) {
    expect(after.history, "Unix growth brings exactly three older rows back").toEqual(before.history.slice(0, -3));
    expect(after.screen).toEqual([...before.history.slice(-3), ...before.screen]);
    expect(after.cursor.y).toBe(before.cursor.y + 3);
  } else {
    expect(after.history, "ConPTY growth leaves older rows in scrollback").toEqual(before.history);
    expect(after.screen, "ConPTY growth appends blank rows below its intact screen").toEqual([...before.screen, "", "", ""]);
    expect(after.cursor.y, "ConPTY's prompt keeps its screen row").toBe(before.cursor.y);
  }
  expect([...after.history, ...after.screen].filter(Boolean), "growth loses or duplicates no generated row")
    .toEqual([...before.history, ...before.screen].filter(Boolean));
}

describe.each(arms)("resize scrollback in the $name arm", ({ shortCols, grownCols }) => {
  test("keeps pullback enabled by default", async () => {
    const term = terminal(await instance());
    shrinkWithHistory(term, shortCols);
    grow(term, grownCols, true);
  });

  test("disables pullback on an existing terminal before its next resize", async () => {
    const vt = await instance();
    const term = terminal(vt);
    shrinkWithHistory(term, shortCols);
    vt.setResizePullScrollback(false);
    grow(term, grownCols, false);
  });

  test("applies an option selected before terminal creation", async () => {
    const vt = await instance();
    vt.setResizePullScrollback(false);
    const term = terminal(vt);
    shrinkWithHistory(term, shortCols);
    grow(term, grownCols, false);
  });

  test("restores pullback when a later session uses an ordinary PTY", async () => {
    const vt = await instance();
    vt.setResizePullScrollback(false);
    const term = terminal(vt);
    shrinkWithHistory(term, shortCols);
    grow(term, grownCols, false);
    term.resize(shortCols, 3);
    vt.setResizePullScrollback(true);
    grow(term, grownCols, true);
  });

  test("keeps the option when a widget replaces its freed terminal", async () => {
    const vt = await instance();
    const old = terminal(vt);
    vt.setResizePullScrollback(false);
    free(old);
    const replacement = terminal(vt);
    shrinkWithHistory(replacement, shortCols);
    grow(replacement, grownCols, false);
  });

  test("keeps the option through an in-band terminal reset", async () => {
    const vt = await instance();
    const term = terminal(vt);
    vt.setResizePullScrollback(false);
    term.write("\x1bc");
    shrinkWithHistory(term, shortCols);
    grow(term, grownCols, false);
  });

  test("updates each live terminal of the instance", async () => {
    const vt = await instance();
    const first = terminal(vt);
    const second = terminal(vt);
    shrinkWithHistory(first, shortCols);
    shrinkWithHistory(second, shortCols);
    vt.setResizePullScrollback(false);
    grow(first, grownCols, false);
    grow(second, grownCols, false);
  });

  test("does not change another instance's resize policy", async () => {
    const conpty = await instance();
    const unix = await instance();
    const windowsTerm = terminal(conpty);
    const unixTerm = terminal(unix);
    conpty.setResizePullScrollback(false);
    shrinkWithHistory(windowsTerm, shortCols);
    shrinkWithHistory(unixTerm, shortCols);
    grow(windowsTerm, grownCols, false);
    grow(unixTerm, grownCols, true);
  });
});
