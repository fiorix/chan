// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { CanvasRenderer, SelectionManager, Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { installGhosttyClickExtents, installGhosttySelection } from "./ghosttySelection";
import { GhosttyVt, VtTerminal } from "@chan/ghostty-web-ng/vt";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 4;

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
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
/// the DOM render loop, its canvas in the host element open() would take.
/// `install` installs chan's selection with a writer that records each text
/// in `writes`, and `installClicks` chan's double and triple click.
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
  const host = document.createElement("div");
  host.append(canvas);
  document.body.append(host);
  (term as unknown as { element: HTMLElement }).element = host;
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
    installClicks: () => installGhosttyClickExtents(term),
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

describe("a double or triple click selects across a soft wrap, as xterm.js's do", () => {
  /// A path that wraps at 20 columns inside its word: "$ cat /var/log/messa"
  /// and "ges.1", then a short row.
  const PATH = "/var/log/messages.1";
  const COMMAND = `$ cat ${PATH}`;
  const SCREEN = `${COMMAND}\r\nok`;

  function click(canvas: HTMLCanvasElement, cell: { width: number; height: number }, detail: number, col: number, row: number) {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail,
      clientX: col * cell.width + 1,
      clientY: row * cell.height + 1,
    });
    canvas.dispatchEvent(event);
    return event;
  }

  async function clicks(screen: string) {
    const pinned = await pinnedTerminal(screen);
    expect(pinned.install()).toBe(true);
    expect(pinned.installClicks()).not.toBeNull();
    return pinned;
  }

  test("a double click on either side of the wrap selects and copies the whole word, once", async () => {
    const { term, canvas, cell, writes, wasmTerm } = await clicks(SCREEN);
    expect(wasmTerm.isRowWrapped(1), "the command wrapped inside the path").toBe(true);
    click(canvas, cell, 2, 9, 0);
    expect(writes).toEqual([PATH]);
    expect(term.getSelection()).toBe(PATH);
    click(canvas, cell, 2, 1, 1);
    expect(writes).toEqual([PATH, PATH]);
  });

  test("a triple click on either row selects and copies the whole wrapped line, once", async () => {
    const { term, canvas, cell, writes } = await clicks(SCREEN);
    click(canvas, cell, 3, 0, 1);
    expect(writes).toEqual([COMMAND]);
    expect(term.getSelection()).toBe(COMMAND);
    click(canvas, cell, 3, 15, 0);
    expect(writes).toEqual([COMMAND, COMMAND]);
    click(canvas, cell, 3, 1, 2);
    expect(writes).toEqual([COMMAND, COMMAND, "ok"]);
  });

  test("a line that wrapped over history rows onto the screen selects whole from the screen", async () => {
    // A command over three rows on a screen of four: its first two rows
    // scroll into the history, wrapped one into the other.
    const path = "/srv/backups/nightly/archive-2026-11-11-full.tar.gz";
    const command = `$ cat ${path}`;
    const { canvas, cell, writes, wasmTerm } = await clicks(`${command}\r\n1\r\n2\r\n3`);
    expect(wasmTerm.getScrollbackLength()).toBe(2);
    expect(wasmTerm.isScrollbackRowWrapped(1), "the history's second row continues its first").toBe(true);
    expect(wasmTerm.isRowWrapped(0), "the screen's first row continues the history").toBe(true);
    click(canvas, cell, 2, 2, 0);
    click(canvas, cell, 3, 2, 0);
    expect(writes).toEqual([path, command]);
  });

  test("a word or a line stops at a hard line break and at a word that does not cross the wrap", async () => {
    const full = "abcdefghijklmnopqrst";
    const { canvas, cell, writes, wasmTerm } = await clicks(`${full}\r\nuvw\r\n$ echo one two three four`);
    expect(wasmTerm.isRowWrapped(1), "a full row then a line break").toBe(false);
    expect(wasmTerm.isRowWrapped(3), "the echo wrapped at a space").toBe(true);
    click(canvas, cell, 2, 19, 0);
    click(canvas, cell, 3, 0, 1);
    click(canvas, cell, 2, 16, 2);
    expect(writes).toEqual([full, "uvw", "three"]);
  });

  test("a click on no word or an empty line is ghostty-web's, and finds nothing", async () => {
    const { canvas, cell, writes } = await clicks(SCREEN);
    expect(click(canvas, cell, 2, 1, 0).defaultPrevented).toBe(false);
    click(canvas, cell, 3, 0, 3);
    expect(writes).toEqual([]);
  });

  test("its cleanup gives the clicks back to ghostty-web, which cuts at the wrap", async () => {
    const { canvas, cell, writes, installClicks } = await pinnedTerminal(SCREEN);
    const remove = installClicks();
    expect(remove).not.toBeNull();
    remove!();
    click(canvas, cell, 2, 9, 0);
    click(canvas, cell, 3, 0, 1);
    expect(writes).toEqual([]);
  });
});

describe("installGhosttySelection fails open", () => {
  test("a terminal with no selection manager keeps ghostty-web's selection", () => {
    const term = { wasmTerm: undefined } as unknown as Terminal;
    expect(installGhosttySelection(term, () => {})).toBe(false);
  });

  test("the click extents need ghostty-web's selection manager, its canvas and chan's core", async () => {
    expect(installGhosttyClickExtents({ wasmTerm: undefined } as unknown as Terminal)).toBeNull();
    const { term } = await pinnedTerminal("text");
    term.wasmTerm = {} as unknown as Terminal["wasmTerm"];
    expect(installGhosttyClickExtents(term)).toBeNull();
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
