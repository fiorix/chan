// @vitest-environment jsdom
//
// The Linux desktop's middle click pastes PRIMARY into a terminal with the
// bytes the chord's paste sends: the ghostty core's paste encoder set as
// spaces, every line end a CR, framed under bracketed paste. A real Ghostty
// widget on the vendored core, and a real xterm.js, is opened in the host;
// the desktop bridge stands in for PRIMARY.

import { readFileSync } from "node:fs";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { engineClick, modelPointerCapture } from "../__tests__/pointer";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

const primary = vi.hoisted(() => ({ text: "" as string | null }));

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => true,
  readPrimarySelection: async () => primary.text,
  writePrimarySelection: async () => {},
}));
vi.mock("../state/shortcuts", () => ({ currentOS: () => "linux" }));

import { installTerminalPrimarySelection } from "./primarySelection";

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
/// ghosttyPaste.test.ts's text and the bytes a ghostty terminal pastes for it.
const HOSTILE = "echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred\x1b[0m'\tdone\x03\x15\x7f\nlast";
const CLEANED = "echo one [201~; echo two\rprintf ' [31mred [0m'\tdone   \rlast";

let Terminal: typeof XtermTerminal;
let vendored: WebAssembly.Module;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 8 }),
    fillRect() {},
    clearRect() {},
    fillText() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (window as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  ({ Terminal } = await import("@xterm/xterm"));
  vendored = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/// A real xterm.js terminal in a host with chan's PRIMARY listeners; `sent`
/// is every string it hands the program.
async function openedXterm(bracketed: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 6 });
  term.open(host);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  if (bracketed) await new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve));
  const uninstall = installTerminalPrimarySelection(host, term, "xterm", () => {});
  if (!uninstall) throw new Error("no PRIMARY listeners on the Linux desktop");
  cleanups.push(uninstall, () => term.dispose());
  return { target: host, sent };
}

/// A real Ghostty widget on the vendored core in a host with chan's PRIMARY
/// listeners, its canvas the target a middle click lands on; `sent` is
/// every string it hands the program.
async function openedGhostty(bracketed: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const host = document.createElement("div");
  document.body.append(host);
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new GhosttyTerminal({ cols: 40, rows: 6, ghostty: vt, cursorBlink: false, smoothScrollDuration: 0 });
  term.open(host);
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("the widget did not open its canvas");
  modelPointerCapture(canvas);
  const sent: string[] = [];
  term.onData((data) => void sent.push(data));
  if (bracketed) term.write("\x1b[?2004h");
  const uninstall = installTerminalPrimarySelection(host, term, "ghostty", () => {});
  if (!uninstall) throw new Error("no PRIMARY listeners on the Linux desktop");
  cleanups.push(uninstall, () => term.dispose());
  return { target: canvas, sent };
}

describe.each([
  { name: "an xterm.js", open: openedXterm },
  { name: "a Ghostty", open: openedGhostty },
])("a middle click on $name terminal", ({ open }) => {
  test.each([
    { mode: "under bracketed paste", bracketed: true },
    { mode: "without bracketed paste", bracketed: false },
  ])("pastes PRIMARY cleaned $mode, as the chord's paste does", async ({ bracketed }) => {
    primary.text = HOSTILE;
    const { target, sent } = await open(bracketed);
    const { click } = engineClick(target, 1);
    expect(click.defaultPrevented, "the webview does not paste it too").toBe(true);
    await vi.waitFor(() => expect(sent).toEqual([bracketed ? OPEN + CLEANED + CLOSE : CLEANED]));
  });
});
