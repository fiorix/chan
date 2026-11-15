// @vitest-environment jsdom

import type { Terminal } from "@chan/ghostty-web-ng";
import { unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  ...(await import("../__tests__/ghosttyTab")).ghosttyCompatStubs(),
}));

import TerminalTab from "./TerminalTab.svelte";
import {
  attachGhostty, compileGhosttyCore, ghosttyLineText, installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom, output, resetTerminals, seatTerminals, sentFrames, terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink } from "../state/tabs.svelte";
import { GhosttySecretMasker } from "../terminal/secretMaskingGhostty";

const mounted: Array<Record<string, unknown>> = [];
const cleanups: Array<() => void> = [];
let canvas: ReturnType<typeof installSoftwareCanvas>;

installTerminalDom();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  vi.useFakeTimers();
  canvas = installSoftwareCanvas();
  // A zero-size jsdom host is deliberately refused by the PTY size publisher.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 640 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 384 : 0;
  });
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true, secret_masking: true }));
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  resetTerminals();
  ghostty.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function attached() {
  const [tab, sibling] = seatTerminals([
    terminalTab({ broadcastEnabled: true }),
    terminalTab({ id: "term-sibling", broadcastEnabled: true }),
  ]);
  const siblingInput: string[] = [];
  cleanups.push(registerTerminalInputSink(sibling!.id, (data) => siblingInput.push(data)));
  const opened = mountGhostty(TerminalTab, tab!);
  mounted.push(opened.component);
  const terminal = await attachGhostty(ghostty, opened);
  canvas.frame();
  expect(sentFrames(terminal.socket).some((frame) => frame.type === "resize"), "the mounted host has a publishable measured grid").toBe(true);
  terminal.socket.sent.splice(0);
  return { ...terminal, siblingInput };
}

test("a letter typed before the Ghostty write callback reaches the group while its parser reply stays local", async () => {
  const { term, host, socket, siblingInput } = await attached();
  const write = term.write.bind(term);
  let callbacksPending = 0;
  // Observe the widget's real deferred callback without changing its parser
  // or the tab's synchronous origin-tracker completion.
  vi.spyOn(term, "write").mockImplementation((data, done) => {
    callbacksPending += 1;
    write(data, () => {
      callbacksPending -= 1;
      done?.();
    });
  });
  const paint = vi.spyOn(term.renderer!, "render");
  await output(socket, "streamed\x1b[12;3H\x1b[6n");

  expect(ghosttyLineText(term, 0), "the real core has parsed the output").toBe("streamed");
  expect(callbacksPending, "the widget callback still awaits an animation frame").toBe(1);
  expect(paint, "the pending output has not painted").not.toHaveBeenCalled();
  expect(sentFrames(socket).filter((frame) => frame.type === "input" || frame.type === "broadcast-input"))
    .toEqual([{ type: "input", data: "\x1b[12;3R" }]);
  expect(siblingInput, "the parser-generated report is not broadcast").toEqual([]);

  host.dispatchEvent(new KeyboardEvent("keydown", {
    key: "a", code: "KeyA", bubbles: true, cancelable: true,
  }));

  expect(callbacksPending, "the key arrived before that write callback").toBe(1);
  expect(sentFrames(socket).filter((frame) => frame.type === "input" || frame.type === "broadcast-input"))
    .toEqual([
      { type: "input", data: "\x1b[12;3R" },
      { type: "input", data: "a" },
      { type: "broadcast-input", data: "a" },
    ]);
  expect(siblingInput, "the actual widget key reaches the same-window sibling").toEqual(["a"]);
  canvas.frame();
  expect(callbacksPending, "the held callback completes when the frame advances").toBe(0);
});

test("Ghostty publishes its resized PTY grid before invalidating visible secret masks", async () => {
  const { term, socket } = await attached();
  const ownScan = GhosttySecretMasker.prototype.scanViewport;
  const gridsAtScan: Array<Array<Record<string, unknown>>> = [];
  vi.spyOn(GhosttySecretMasker.prototype, "scanViewport").mockImplementation(function (this: GhosttySecretMasker) {
    gridsAtScan.push(sentFrames(socket).filter((frame) => frame.type === "resize"));
    ownScan.call(this);
  });

  term.resize(91, 24);

  expect(gridsAtScan, "the size notification must precede even the synchronous masker call")
    .toEqual([[{ type: "resize", cols: 91, rows: 24 }]]);
  expect(sentFrames(socket).filter((frame) => frame.type === "resize"))
    .toEqual([{ type: "resize", cols: 91, rows: 24 }]);
});
