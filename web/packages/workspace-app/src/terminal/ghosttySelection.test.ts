// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const COLS = 20;
const ROWS = 4;

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/// Open the widget on the vendored core and record its copy callback.
async function pinnedTerminal(input: string) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const writes: string[] = [];
  const term = new Terminal({
    ghostty: vt, cols: COLS, rows: ROWS, cursorBlink: false,
    copy: (text) => void writes.push(text),
  });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  term.write(input);
  const canvas = host.querySelector("canvas")!;
  const cell = term.getMetrics()!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, COLS * cell.width, ROWS * cell.height));
  modelPointerCapture(canvas);
  return { term, core: term.core!, canvas, cell, writes };
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
  test("Select all selects the history and the screen, and copies them as shown", async () => {
    const { term } = await pinnedTerminal(ROWS_0_TO_11);
    term.selectAll();
    expect(term.getSelectionRange()).toEqual({
      start: { col: 0, absoluteRow: 0 },
      end: { col: COLS - 1, absoluteRow: 8 + ROWS - 1 },
    });
    expect(term.getSelection()).toBe(ROWS_0_TO_11.replaceAll("\r\n", "\n"));
    expect(term.hasSelection()).toBe(true);
  });

  test("ghostty-web's own read takes each cluster whole, in the history and on the screen", async () => {
    const { term, core } = await pinnedTerminal("e\u0301 x\r\n1\r\n2\r\n3\r\n4\r\nn\u0303 \u{1f468}\u200d\u{1f469}\u200d\u{1f467}");
    expect(core.getScrollbackLength()).toBe(2);
    term.setSelection({ start: { col: 0, absoluteRow: 0 }, end: { col: COLS - 1, absoluteRow: 5 } });
    expect(term.getSelection()).toBe("e\u0301 x\n1\n2\n3\n4\nn\u0303 \u{1f468}\u200d\u{1f469}\u200d\u{1f467}");
  });

  test("a selection is read the way round it was made", async () => {
    const { term } = await pinnedTerminal("hello world\r\nsecond row");
    term.setSelection({ start: { col: 4, absoluteRow: 0 }, end: { col: 0, absoluteRow: 0 } });
    expect(term.getSelection()).toBe("hello");
    term.setSelection({ start: { col: 5, absoluteRow: 1 }, end: { col: 6, absoluteRow: 0 } });
    expect(term.getSelection()).toBe("world\nsecond");
  });

  test("no selection copies nothing", async () => {
    const { term } = await pinnedTerminal("text");
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
    const { term, writes } = await pinnedTerminal(SCREEN);
    term.setSelection({ start: { col: 0, absoluteRow: 0 }, end: { col: 4, absoluteRow: 1 } });
    expect(term.copySelection()).toBe(true);
    expect(writes).toEqual([COMMAND]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a drag over the wrapped command copies it on release as one line", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes } = await pinnedTerminal(SCREEN);
    const at = (col: number, row: number) => ({ clientX: col * cell.width + 1, clientY: row * cell.height + 1 });
    mousePointer(canvas, "pointerdown", at(0, 0));
    mousePointer(canvas, "pointermove", at(4, 1));
    // The engine retargets the release to the captured canvas.
    mousePointer(canvas, "pointerup", at(4, 1));
    expect(writes).toEqual([COMMAND]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a press and release without a drag selects nothing and copies nothing", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes } = await pinnedTerminal(SCREEN);
    const at = { clientX: 2 * cell.width + 1, clientY: 1 };
    mousePointer(canvas, "pointerdown", at);
    mousePointer(canvas, "pointerup", at);
    expect(writes).toEqual([]);
    expect(term.hasSelection()).toBe(false);
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("a double click copies the word under it", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes } = await pinnedTerminal(SCREEN);
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 2, clientX: 8 * cell.width + 1, clientY: 1 }),
    );
    expect(writes).toEqual(["one"]);
    expect(writes[0]).toBe(chordText(term));
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  test("a triple click copies the row under it", async () => {
    const clipboard = browserClipboard();
    const { term, canvas, cell, writes } = await pinnedTerminal(SCREEN);
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
    return pinnedTerminal(screen);
  }

  test("a double click on either side of the wrap selects and copies the whole word, once", async () => {
    const { term, canvas, cell, writes, core } = await clicks(SCREEN);
    expect(core.isRowWrapped(1), "the command wrapped inside the path").toBe(true);
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
    const { canvas, cell, writes, core } = await clicks(`${command}\r\n1\r\n2\r\n3`);
    expect(core.getScrollbackLength()).toBe(2);
    expect(core.isScrollbackRowWrapped(1), "the history's second row continues its first").toBe(true);
    expect(core.isRowWrapped(0), "the screen's first row continues the history").toBe(true);
    click(canvas, cell, 2, 2, 0);
    click(canvas, cell, 3, 2, 0);
    expect(writes).toEqual([path, command]);
  });

  test("a word or a line stops at a hard line break and at a word that does not cross the wrap", async () => {
    const full = "abcdefghijklmnopqrst";
    const { canvas, cell, writes, core } = await clicks(`${full}\r\nuvw\r\n$ echo one two three four`);
    expect(core.isRowWrapped(1), "a full row then a line break").toBe(false);
    expect(core.isRowWrapped(3), "the echo wrapped at a space").toBe(true);
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

});
