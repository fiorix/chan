// @vitest-environment jsdom

import type { Terminal } from "@chan/ghostty-web-ng";
import { unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});

import TerminalTab from "./TerminalTab.svelte";
import {
  attachGhostty, compileGhosttyCore, ghosttyCellMetrics, ghosttyLineText, installSoftwareCanvas, mountGhostty,
  observeGhosttyPaints,
} from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom, output, resetTerminals, seatTerminals, sentFrames, terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink } from "../state/tabs.svelte";
import { SecretAssignmentMatcher } from "../terminal/secretMasking";

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
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: true }));
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
  const paints = observeGhosttyPaints(term);
  await output(socket, "streamed\x1b[12;3H\x1b[6n");

  expect(ghosttyLineText(term, 0), "the real core has parsed the output").toBe("streamed");
  expect(callbacksPending, "the widget callback still awaits an animation frame").toBe(1);
  expect(paints, "the pending output has not painted").toEqual([]);
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
  expect(paints.length, "the frame paints the output").toBeGreaterThan(0);
});

test("Ghostty publishes its resized PTY grid before scanning and painting rewrapped secrets", async () => {
  const { term, host, socket } = await attached();
  const secret = "TOKEN=abcdefghijklmnopqrstuvwx";
  const find = SecretAssignmentMatcher.prototype.find;
  const scans: Array<{ text: string; ranges: Array<{ start: number; end: number }>; grids: Array<Record<string, unknown>> }> = [];
  // Observe the real scan's matcher, not the request to invalidate its cache.
  vi.spyOn(SecretAssignmentMatcher.prototype, "find").mockImplementation(function (this: SecretAssignmentMatcher, text) {
    const ranges = find.call(this, text);
    if (text.includes("TOKEN=")) {
      scans.push({ text: text.trimEnd(), ranges, grids: sentFrames(socket).filter((frame) => frame.type === "resize") });
    }
    return ranges;
  });
  const context = canvas.context(host);
  const { width, height } = ghosttyCellMetrics(term);
  const mask = { r: 108, g: 108, b: 112, a: 1 };
  const pixel = (column: number, row: number) => context.pixelAt((column + 0.5) * width, (row + 0.5) * height);
  await output(socket, secret);
  canvas.frame();

  expect(scans, "the mounted masker scans the real core's secret").toEqual([
    { text: secret, ranges: [{ start: 6, end: 30 }], grids: [] },
  ]);
  for (let column = 6; column < 30; column += 1) expect(pixel(column, 0)).toEqual(mask);
  scans.splice(0);
  socket.sent.splice(0);

  term.resize(20, 24);

  expect(scans, "the PTY already has the new grid when the real masker scans its rewrapped value").toEqual([
    { text: secret, ranges: [{ start: 6, end: 30 }], grids: [{ type: "resize", cols: 20, rows: 24 }] },
  ]);
  expect(sentFrames(socket).filter((frame) => frame.type === "resize"))
    .toEqual([{ type: "resize", cols: 20, rows: 24 }]);
  expect(ghosttyLineText(term, 0)).toBe(secret.slice(0, 20));
  expect(ghosttyLineText(term, 1)).toBe(secret.slice(20));
  for (let column = 6; column < 20; column += 1) expect(pixel(column, 0)).toEqual(mask);
  for (let column = 0; column < 10; column += 1) expect(pixel(column, 1)).toEqual(mask);
  expect(pixel(5, 0), "the assignment name stays unmasked").not.toEqual(mask);
  expect(pixel(10, 1), "the mask ends at the wrapped value").not.toEqual(mask);
  expect(pixel(11, 1), "the mask ends with the wrapped value").not.toEqual(mask);
});
