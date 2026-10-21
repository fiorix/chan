// @vitest-environment jsdom
//
// The tracker over a real xterm.js: data the user made is marked, a reply the
// parser writes is not, and the mark covers one chunk. The internal event the
// tracker reads must resolve on the xterm.js this tree locks, so an upgrade
// that drops it fails here instead of quietly restoring the unmarked route.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { beforeAll, expect, test } from "vitest";
import { trackUserInput } from "./xtermUserInput";

let Terminal: typeof XtermTerminal;

beforeAll(async () => {
  // xterm initializes its color parser through a scratch canvas at import
  // time; no renderer is needed here.
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  ({ Terminal } = await import("@xterm/xterm"));
});

/// A real terminal whose `onData` chunks are recorded with the tracker's
/// mark, as `TerminalTab` reads it.
function terminal() {
  const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 4 });
  const tracker = trackUserInput(term);
  const chunks: Array<[string, boolean]> = [];
  term.onData((data) => chunks.push([data, tracker?.take() ?? false]));
  return { term, tracker, chunks };
}

function written(term: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

test("resolves on the locked xterm.js", () => {
  expect(terminal().tracker).not.toBeNull();
});

test("marks the user's data and not the parser's reply", async () => {
  const { term, chunks } = terminal();
  term.input("k");
  term.input("\x1b[97;5u");
  // A cursor position request: the parser answers it on its own.
  await written(term, "\x1b[6n");
  expect(chunks).toEqual([
    ["k", true],
    ["\x1b[97;5u", true],
    ["\x1b[1;1R", false],
  ]);
});

test("a reply after a key is not marked by the key", async () => {
  const { term, chunks } = terminal();
  term.input("k");
  await written(term, "\x1b[5n");
  expect(chunks).toEqual([
    ["k", true],
    ["\x1b[0n", false],
  ]);
});

test("is null on a terminal without the internal event", () => {
  expect(trackUserInput({} as XtermTerminal)).toBeNull();
});
