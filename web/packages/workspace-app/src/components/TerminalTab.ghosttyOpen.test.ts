// @vitest-environment jsdom
//
// A ghostty terminal that opens in a pane that is not the focused one moves
// no focus, and one that opens in the focused pane takes the keyboard. A
// terminal opens in a background pane when `cs terminal new` or a team spawns
// one there, and at a session restore, while a field that ends its edit on
// blur may hold the keyboard: a CSV cell being edited, a tab being renamed, a
// chord being captured. TerminalTab is mounted on ghostty-web's own Terminal
// over the binding on the vendored core, so what the open does to the
// keyboard is the widget's; only the renderer hooks a software canvas cannot
// serve are stubbed. Each reading waits past focus()'s zero-delay retry.

import { readFileSync } from "node:fs";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({ module: null as WebAssembly.Module | null }));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const widget = await import("@chan/ghostty-web-ng");
  return { ...actual, loadGhosttyKit: async () => actual.ghosttyKitFrom(ghostty.module!, widget) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));

import TerminalTab from "./TerminalTab.svelte";
import CsvTable from "../editor/CsvTable.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  seatTerminals,
  TERMINAL_PANE,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

installTerminalDom();

beforeAll(async () => {
  ghostty.module = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  // The widget's render loop asks for a frame from every frame.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
});

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const pastRetry = () => new Promise((resolve) => setTimeout(resolve, 20));

/// Mount a ghostty terminal, attached and ready, in a pane that is the
/// focused one or not.
async function openGhostty(focused: boolean): Promise<HTMLElement> {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused } }),
  );
  await vi.waitFor(() => expect(TerminalSocket.all.length).toBeGreaterThan(0));
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  const host = target.querySelector<HTMLElement>(".terminal-host")!;
  expect(host.querySelector("canvas"), "the widget opened in the host").not.toBeNull();
  return host;
}

/// A field holding the keyboard, with every focus change it sees.
function fieldHoldingTheKeyboard(): { field: HTMLInputElement; seen: string[] } {
  const field = document.createElement("input");
  document.body.append(field);
  const seen: string[] = [];
  for (const type of ["blur", "focus"]) field.addEventListener(type, () => void seen.push(type));
  field.focus();
  seen.length = 0;
  return { field, seen };
}

describe("a ghostty terminal opening in a background pane", () => {
  test("moves no focus: the field holding the keyboard sees no blur and keeps it", async () => {
    const { field, seen } = fieldHoldingTheKeyboard();
    const host = await openGhostty(false);
    await pastRetry();
    expect(seen, "the field saw no focus change").toEqual([]);
    expect(document.activeElement).toBe(field);
    expect(host.contains(document.activeElement)).toBe(false);
  });

  test("leaves a CSV cell's edit open, holding the keyboard", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const value = "name,count\nfigs,1\n";
    mounted.push(mount(CsvTable, { target, props: { value } }));
    target.querySelector<HTMLButtonElement>('button[data-cell="1:0"]')!.click();
    flushSync();
    const input = target.querySelector<HTMLInputElement>("td input")!;
    expect(document.activeElement, "the cell's edit holds the keyboard").toBe(input);
    input.value = "plums";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await openGhostty(false);
    await pastRetry();
    await tick();
    expect(target.querySelector("td input"), "the edit is still open").toBe(input);
    expect(input.value).toBe("plums");
    expect(document.activeElement).toBe(input);
  });
});

describe("a ghostty terminal opening in the focused pane", () => {
  test("takes the keyboard", async () => {
    const { field, seen } = fieldHoldingTheKeyboard();
    const host = await openGhostty(true);
    await pastRetry();
    expect(document.activeElement).toBe(host);
    expect(seen).toEqual(["blur"]);
    expect(field.isConnected).toBe(true);
  });
});
