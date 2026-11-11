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
  vi.unstubAllGlobals();
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
/// the DOM render loop. `install` installs chan's selection with a writer
/// that records each text in `writes`.
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
  const canvas = document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1 });
  renderer.resize(COLS, ROWS);
  term.renderer = renderer;
  const manager = new SelectionManager(term, renderer, wasmTerm, document.createElement("textarea"));
  (term as unknown as { selectionManager: SelectionManager }).selectionManager = manager;
  const writes: string[] = [];
  return {
    term,
    manager: manager as unknown as Manager,
    wasmTerm: wasmTerm as unknown as VtTerminal,
    canvas,
    cell: renderer.getMetrics(),
    writes,
    install: () => installGhosttySelection(term, (text) => void writes.push(text)),
  };
}

/// A browser clipboard whose every write is recorded: ghostty-web's own
/// copies write through ClipboardItem where it exists, as in Chrome and
/// WebKit, and writeText otherwise.
function browserClipboard() {
  const clipboard = { write: vi.fn(async () => {}), writeText: vi.fn(async () => {}) };
  vi.stubGlobal("ClipboardItem", class {
    constructor(readonly items: Record<string, Blob>) {}
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  return clipboard;
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
    const { term, manager, install } = await pinnedTerminal(ROWS_0_TO_11);
    expect(install()).toBe(true);
    term.selectAll();
    expect(manager.selectionStart).toEqual({ col: 0, absoluteRow: 0 });
    expect(manager.selectionEnd).toEqual({ col: COLS - 1, absoluteRow: 8 + ROWS - 1 });
    expect(term.getSelection()).toBe(ROWS_0_TO_11.replaceAll("\r\n", "\n"));
    expect(term.hasSelection()).toBe(true);
  });

  test("a selection copies what its rows show, a wide character once", async () => {
    const { term, manager, install } = await pinnedTerminal("日本語 x\r\nab");
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 1 };
    // ghostty-web's own read puts a space after each wide character.
    expect(term.getSelection()).toBe("日 本 語  x\nab");
    expect(install()).toBe(true);
    expect(term.getSelection()).toBe("日本語 x\nab");
  });

  test("a soft-wrapped command copies as the one line it is", async () => {
    const command = "$ echo one two three four";
    const { term, manager, wasmTerm, install } = await pinnedTerminal(`${command}\r\nok`);
    expect(wasmTerm.isRowWrapped(1), "the command wrapped on screen").toBe(true);
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 2 };
    // ghostty-web's own read ends the wrapped row with a line break.
    expect(term.getSelection()).toBe("$ echo one two three\n four\nok");
    expect(install()).toBe(true);
    expect(term.getSelection()).toBe(`${command}\nok`);
  });

  test("a DEL a program printed reaches no copy", async () => {
    const { term, manager, install } = await pinnedTerminal("ab\x7fcd");
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: COLS - 1, absoluteRow: 0 };
    expect(term.getSelection(), "ghostty-web's own read carries it").toBe("ab\x7fcd");
    expect(install()).toBe(true);
    expect(term.getSelection()).toBe("abcd");
  });

  test("a selection is read the way round it was made", async () => {
    const { term, manager, install } = await pinnedTerminal("hello world\r\nsecond row");
    expect(install()).toBe(true);
    manager.selectionStart = { col: 4, absoluteRow: 0 };
    manager.selectionEnd = { col: 0, absoluteRow: 0 };
    expect(term.getSelection()).toBe("hello");
    manager.selectionStart = { col: 5, absoluteRow: 1 };
    manager.selectionEnd = { col: 6, absoluteRow: 0 };
    expect(term.getSelection()).toBe("world\nsecond");
  });

  test("no selection copies nothing", async () => {
    const { term, install } = await pinnedTerminal("text");
    expect(install()).toBe(true);
    expect(term.getSelection()).toBe("");
  });
});

describe("ghostty-web's own copies write through chan's writer", () => {
  /// A command that wraps at 20 columns, its two rows, and a short row.
  const COMMAND = "$ echo one two three four";
  const SCREEN = `${COMMAND}\r\nok`;

  /// The text the copy chord and the menu's Copy read for the current
  /// selection, the way TerminalTab reads it.
  const chordText = (term: Terminal) => term.getSelection();

  test("copySelection writes the selection's text, and the browser clipboard is not touched", async () => {
    const clipboard = browserClipboard();
    const { term, manager, writes, install } = await pinnedTerminal(SCREEN);
    expect(install()).toBe(true);
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: 4, absoluteRow: 1 };
    expect(manager.copySelection()).toBe(true);
    expect(writes).toEqual([COMMAND]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a drag over the wrapped command copies it on release as one line", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes, install } = await pinnedTerminal(SCREEN);
    expect(install()).toBe(true);
    const at = (col: number, row: number) => ({ clientX: col * cell.width + 1, clientY: row * cell.height + 1 });
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...at(0, 0) }));
    canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...at(4, 1) }));
    // ghostty-web hears the release on the document.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...at(4, 1) }));
    expect(writes).toEqual([COMMAND]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a double click copies the word under it", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes, install } = await pinnedTerminal(SCREEN);
    expect(install()).toBe(true);
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 2, clientX: 8 * cell.width + 1, clientY: 1 }),
    );
    expect(writes).toEqual(["one"]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  test("a triple click copies the row under it", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes, install } = await pinnedTerminal(SCREEN);
    expect(install()).toBe(true);
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 3, clientX: 1, clientY: 2 * cell.height + 1 }),
    );
    expect(writes).toEqual(["ok"]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
  });
});

describe("installGhosttySelection fails open", () => {
  test("a terminal with no selection manager keeps ghostty-web's selection", () => {
    const term = { wasmTerm: undefined } as unknown as Terminal;
    expect(installGhosttySelection(term, () => {})).toBe(false);
  });

  test("a selection manager over another core keeps ghostty-web's read and copy", async () => {
    const { term, manager } = await pinnedTerminal("text");
    term.wasmTerm = {} as unknown as Terminal["wasmTerm"];
    const read = manager.getSelection;
    const selectAll = manager.selectAll;
    const copy = manager.copyToClipboard;
    expect(installGhosttySelection(term, () => {})).toBe(false);
    expect(manager.getSelection).toBe(read);
    expect(manager.selectAll).toBe(selectAll);
    expect(manager.copyToClipboard).toBe(copy);
  });
});
