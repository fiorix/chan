// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { CanvasRenderer, SelectionManager, Terminal } from "ghostty-web";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { installGhosttySelection } from "./ghosttySelection";
import { GhosttyVt, VtTerminal } from "./ghosttyVt";

const VENDORED = "vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 4;

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Anchor = { col: number; absoluteRow: number };

/// The selection manager's members a test reads and sets.
type Manager = {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  getSelection(): string;
  selectAll(): void;
  copySelection(): boolean;
  copyToClipboard(text: string): void;
};

/// ghostty-web's Terminal and its own SelectionManager, wired as open()
/// wires them, over the binding's terminal on the vendored core, without
/// the DOM render loop. `scrolledBack` is the viewport offset in lines.
async function pinnedTerminal(input: string) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ ghostty: vt.asGhostty(), cols: COLS, rows: ROWS });
  const wasmTerm = vt.createTerminal(COLS, ROWS, { scrollbackLimit: 100 });
  wasmTerm.write(input);
  term.wasmTerm = wasmTerm;
  const renderer = new CanvasRenderer(document.createElement("canvas"), { devicePixelRatio: 1 });
  renderer.resize(COLS, ROWS);
  term.renderer = renderer;
  const manager = new SelectionManager(term, renderer, wasmTerm, document.createElement("textarea"));
  (term as unknown as { selectionManager: SelectionManager }).selectionManager = manager;
  return { term, manager: manager as unknown as Manager, wasmTerm: wasmTerm as unknown as VtTerminal };
}

const ROWS_0_TO_11 = Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\r\n");

describe("ghostty-web's selection over the pinned build", () => {
  test("its own Select all takes a screenful counted from the top of the history", async () => {
    const { term, wasmTerm } = await pinnedTerminal(ROWS_0_TO_11);
    expect(wasmTerm.getScrollbackLength()).toBe(8);
    term.selectAll();
    // Rows 8 to 11 are on screen; ghostty-web reads its viewport offset (0)
    // as an absolute row.
    expect(term.getSelection()).toBe("row 0\nrow 1\nrow 2\nrow 3");
  });

  test("Select all selects the history and the screen, and copies them as shown", async () => {
    const { term, manager } = await pinnedTerminal(ROWS_0_TO_11);
    expect(installGhosttySelection(term)).toBe(true);
    term.selectAll();
    expect(manager.selectionStart).toEqual({ col: 0, absoluteRow: 0 });
    expect(manager.selectionEnd).toEqual({ col: COLS - 1, absoluteRow: 8 + ROWS - 1 });
    expect(term.getSelection()).toBe(ROWS_0_TO_11.replaceAll("\r\n", "\n"));
    expect(term.hasSelection()).toBe(true);
  });

  test("a selection copies what its rows show, a wide character once", async () => {
    const { term, manager } = await pinnedTerminal("日本語 x\r\nab");
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 1 };
    // ghostty-web's own read puts a space after each wide character.
    expect(term.getSelection()).toBe("日 本 語  x\nab");
    expect(installGhosttySelection(term)).toBe(true);
    expect(term.getSelection()).toBe("日本語 x\nab");
  });

  test("a soft-wrapped command copies as the one line it is", async () => {
    const command = "$ echo one two three four";
    const { term, manager, wasmTerm } = await pinnedTerminal(`${command}\r\nok`);
    expect(wasmTerm.isRowWrapped(1), "the command wrapped on screen").toBe(true);
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 2 };
    // ghostty-web's own read ends the wrapped row with a line break.
    expect(term.getSelection()).toBe("$ echo one two three\n four\nok");
    expect(installGhosttySelection(term)).toBe(true);
    expect(term.getSelection()).toBe(`${command}\nok`);
  });

  test("a DEL a program printed reaches no copy", async () => {
    const { term, manager } = await pinnedTerminal("ab\x7fcd");
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 0 };
    expect(term.getSelection(), "ghostty-web's own read carries it").toBe("ab\x7fcd");
    expect(installGhosttySelection(term)).toBe(true);
    expect(term.getSelection()).toBe("abcd");
  });

  test("a selection is read the way round it was made", async () => {
    const { term, manager } = await pinnedTerminal("hello world\r\nsecond row");
    expect(installGhosttySelection(term)).toBe(true);
    manager.selectionStart = { col: 4, absoluteRow: 0 };
    manager.selectionEnd = { col: 0, absoluteRow: 0 };
    expect(term.getSelection()).toBe("hello");
    manager.selectionStart = { col: 5, absoluteRow: 1 };
    manager.selectionEnd = { col: 6, absoluteRow: 0 };
    expect(term.getSelection()).toBe("world\nsecond");
  });

  test("ghostty-web's own copies read the same text", async () => {
    const { term, manager } = await pinnedTerminal("日本語");
    expect(installGhosttySelection(term)).toBe(true);
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 0 };
    const copied = vi.spyOn(manager, "copyToClipboard").mockImplementation(() => {});
    expect(manager.copySelection()).toBe(true);
    expect(copied).toHaveBeenCalledWith("日本語");
  });

  test("no selection copies nothing", async () => {
    const { term } = await pinnedTerminal("text");
    expect(installGhosttySelection(term)).toBe(true);
    expect(term.getSelection()).toBe("");
  });
});

describe("installGhosttySelection fails open", () => {
  test("a terminal with no selection manager keeps ghostty-web's selection", () => {
    const term = { wasmTerm: undefined } as unknown as Terminal;
    expect(installGhosttySelection(term)).toBe(false);
  });

  test("a selection manager over another core keeps ghostty-web's read", async () => {
    const { term, manager } = await pinnedTerminal("text");
    term.wasmTerm = {} as unknown as Terminal["wasmTerm"];
    const read = manager.getSelection;
    const selectAll = manager.selectAll;
    expect(installGhosttySelection(term)).toBe(false);
    expect(manager.getSelection).toBe(read);
    expect(manager.selectAll).toBe(selectAll);
  });
});
