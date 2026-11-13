// @vitest-environment jsdom
//
// A ghostty terminal gives up the keyboard on blur() from whichever of its
// elements holds it. ghostty-web's Terminal is opened over the binding on the
// vendored core in a host element. A press on its canvas focuses the hidden
// textarea inside the host; a left press then focuses the host again through
// the selection manager, while a middle or right press (the right one opens
// chan's terminal menu) leaves the textarea holding the keyboard. chan's own
// focus focuses the host. The input handler's key listener sits on the host,
// so a key reaches the program from either. open() focuses the host, and so
// does focus(), each again on a zero-delay timer, so every reading after a
// blur waits a task for that timer. What the terminal hands the program is
// what its onData fires.

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// A ghostty-web terminal on the vendored core, opened in a host; `sent` is
/// every string the terminal handed the program.
async function openTerminal() {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: 40, rows: 6, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  const textarea = host.querySelector("textarea");
  const canvas = host.querySelector("canvas");
  if (!textarea || !canvas) throw new Error("ghostty-web opened no textarea or canvas");
  return { term, host, textarea, canvas, sent };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/// A key typed at whatever holds the keyboard, as the browser targets it.
function typeKey(key: string, code: string): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
}

describe("blur() on a ghostty terminal", () => {
  test.each([
    { press: "left", button: 0, holder: "host" },
    { press: "middle", button: 1, holder: "textarea" },
    { press: "right", button: 2, holder: "textarea" },
  ] as const)(
    "after a $press press on the canvas, neither the host nor the textarea keeps the keyboard and no key reaches the program",
    async ({ button, holder }) => {
      const { term, host, textarea, canvas, sent } = await openTerminal();
      canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));
      expect(document.activeElement, `the press leaves the ${holder} holding the keyboard`).toBe(
        holder === "host" ? host : textarea,
      );
      typeKey("a", "KeyA");
      expect(sent, "a key reaches the program while the terminal holds the keyboard").toEqual(["a"]);

      term.blur();
      await nextTask();
      expect(document.activeElement).not.toBe(textarea);
      expect(document.activeElement).not.toBe(host);
      expect(document.activeElement).toBe(document.body);
      typeKey("ArrowUp", "ArrowUp");
      expect(sent, "an arrow after the blur reaches no program").toEqual(["a"]);
    },
  );

  test("after the right press's context menu, blur() gives the keyboard up", async () => {
    const { term, textarea, canvas, sent } = await openTerminal();
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    expect(document.activeElement, "the context menu focuses the textarea").toBe(textarea);

    term.blur();
    await nextTask();
    expect(document.activeElement).toBe(document.body);
    typeKey("ArrowUp", "ArrowUp");
    expect(sent).toEqual([]);
  });

  test("with the host focused, blur() gives the keyboard up too", async () => {
    const { term, host, sent } = await openTerminal();
    host.focus();
    expect(document.activeElement).toBe(host);

    term.blur();
    await nextTask();
    expect(document.activeElement).toBe(document.body);
    typeKey("ArrowUp", "ArrowUp");
    expect(sent).toEqual([]);
  });

  test("with the keyboard outside the terminal, blur() leaves it where it is", async () => {
    const { term } = await openTerminal();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    term.blur();
    await nextTask();
    expect(document.activeElement).toBe(input);
  });

  test("right after focus(), blur() leaves no retry to take the keyboard back", async () => {
    const { term, host, sent } = await openTerminal();
    await nextTask();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    term.focus();
    expect(document.activeElement).toBe(host);
    term.blur();
    expect(document.activeElement).toBe(document.body);
    await nextTask();
    expect(document.activeElement, "focus()'s retry ran after the blur").toBe(document.body);
    typeKey("ArrowUp", "ArrowUp");
    expect(sent).toEqual([]);
  });
});
