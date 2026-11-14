// @vitest-environment jsdom
//
// The Linux desktop's middle click pastes PRIMARY into an xterm.js terminal
// with the bytes the chord's paste sends: the ghostty core's paste encoder
// set as spaces, every line end a CR, framed under bracketed paste. A real
// xterm.js is opened in the host; the desktop bridge stands in for PRIMARY.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

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
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
});

/// A real xterm.js terminal in a host with chan's PRIMARY listeners; `sent`
/// is every string it hands the program.
async function opened(bracketed: boolean) {
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
  return { host, sent };
}

describe.each([
  { mode: "under bracketed paste", bracketed: true },
  { mode: "without bracketed paste", bracketed: false },
])("a middle click on an xterm.js terminal $mode", ({ bracketed }) => {
  test("pastes PRIMARY cleaned, as the chord's paste does", async () => {
    primary.text = HOSTILE;
    const { host, sent } = await opened(bracketed);
    const click = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    host.dispatchEvent(click);
    expect(click.defaultPrevented, "the webview does not paste it too").toBe(true);
    await vi.waitFor(() => expect(sent).toEqual([bracketed ? OPEN + CLEANED + CLOSE : CLEANED]));
  });
});
