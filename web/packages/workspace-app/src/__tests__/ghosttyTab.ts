// A real Ghostty widget and vendored core behind TerminalTab's mocked
// loader. No component or backend value is imported here: mock factories
// can load this module while those modules are still initializing.
//
// The shared fixture, at the end, is how a mounted test opens a terminal:
// a file declares its two factories,
//
//   vi.mock("../terminal/backend", async (importOriginal) =>
//     (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
//   vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
//     (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));
//
// and every terminal it opens, through `mountGhosttyTerminal`, which returns
// it, through `mountTerminal` or through the app, is the widget over the
// vendored core.

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { mount, type Component } from "svelte";
import { expect, vi } from "vitest";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import type { GhosttyKit, ghosttyKitFrom } from "../terminal/backend";
import { SoftwareCanvasContext, softwareGetContext } from "./softwareCanvas";
import {
  attach,
  ghosttyFixtureDeclared,
  mountTerminal,
  receive,
  TERMINAL_PANE,
  TerminalSocket,
  useGhosttyFixture,
} from "./terminalTab";

export type GhosttyRuntime = {
  module: WebAssembly.Module | null;
  terminals: Terminal[];
  events?: string[];
};

export async function compileGhosttyCore(runtime: GhosttyRuntime): Promise<void> {
  runtime.module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
}

export function recordingKit(runtime: GhosttyRuntime, kitFrom: typeof ghosttyKitFrom): GhosttyKit {
  if (!runtime.module) throw new Error("compile the vendored core before loading a Ghostty kit");
  runtime.events?.push("kit-load");
  class RecordedTerminal extends Terminal {
    constructor(...args: ConstructorParameters<typeof Terminal>) {
      super(...args);
      runtime.terminals.push(this);
    }
  }
  return kitFrom(runtime.module, { Terminal: RecordedTerminal });
}

export function ghosttyCompatStubs() {
  return {
    measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
    alignGhosttyRendererToXterm: () => true,
    installGhosttyCustomGlyphs: () => true,
    installGhosttyOverlayScrollbar: () => true,
  };
}

/// The caller owns mock/global restoration. Frames advance only by frame().
export function installSoftwareCanvas() {
  const contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const environment = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(softwareGetContext(contexts, environment));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    frame(): void {
      const pending = [...frames.keys()];
      for (const id of pending) {
        const callback = frames.get(id);
        frames.delete(id);
        callback?.(performance.now());
      }
    },
    context(target: ParentNode): SoftwareCanvasContext {
      const canvas = target.querySelector("canvas");
      const context = canvas && contexts.get(canvas);
      if (!context) throw new Error("the mounted Ghostty canvas has no software context");
      return context;
    },
  };
}

/// Synchronous so a caller can inspect the tab while its font is pending.
/// The caller owns unmounting and resetting the terminal/socket recorders.
export function mountGhostty(
  TerminalTab: Component<any>,
  tab: TerminalTabState,
  props: { focused?: boolean; active?: boolean; side?: "a" | "b" } = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  const socketCount = TerminalSocket.all.length;
  const component = mount(TerminalTab, {
    target,
    props: { tab, paneId: TERMINAL_PANE, side: props.side ?? "a", active: props.active ?? true, focused: props.focused ?? true },
  }) as Record<string, unknown>;
  return { target, component, socketCount };
}

export async function attachGhostty(
  runtime: GhosttyRuntime,
  mounted: ReturnType<typeof mountGhostty>,
  options: { sessionId?: string; ready?: boolean } = {},
) {
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(mounted.socketCount + 1));
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, options.sessionId === undefined ? {} : { id: options.sessionId });
  if (options.ready !== false) await receive(socket, { type: "ready", cols: 80, rows: 24 });
  const host = mounted.target.querySelector<HTMLElement>(".terminal-host")!;
  expect(host.querySelector("canvas")).not.toBeNull();
  return { host, socket, term: runtime.terminals.at(-1)! };
}

// Widget observations live here so tests state behavior independently of
// the widget's current representation.
export function ghosttyCore(term: Terminal) {
  return term.wasmTerm;
}

export function ghosttyMode(term: Terminal, mode: number): boolean {
  return term.getMode(mode);
}

export function ghosttyAlternateScreen(term: Terminal): boolean {
  return term.wasmTerm!.isAlternateScreen();
}

export function ghosttyMouseTracking(term: Terminal): boolean {
  return term.hasMouseTracking();
}

export function ghosttyCellMetrics(term: Terminal) {
  return term.renderer!.getMetrics();
}

export function ghosttyLineText(term: Terminal, row: number): string | undefined {
  return term.buffer.active.getLine(row)?.translateToString(true);
}

export function ghosttyFontFamily(term: Terminal) {
  return term.options.fontFamily;
}

export function ghosttyCursorColor(term: Terminal) {
  return term.options.theme.cursor;
}

export function ghosttySelect(term: Terminal, column: number, row: number, length: number): void {
  term.select(column, row, length);
}

export function ghosttySelection(term: Terminal): string {
  return term.getSelection();
}

export function ghosttyClearSelection(term: Terminal): void {
  term.clearSelection();
}

// The shared fixture. A test file gets its own module graph, so this state
// is per file: the core compiles once when the file declares the factories,
// and each terminal instantiates it into its own memory, as in the product.

/// The terminals the fixture opened since the last `resetTerminals`.
export const ghosttyFixture: GhosttyRuntime = { module: null, terminals: [] };

let coreCompiled: Promise<void> | null = null;

/// The `vi.mock("../terminal/backend", ...)` factory. Every terminal opens on
/// the widget, as in the product, and the loader hands out the vendored core
/// instead of fetching it.
export async function ghosttyBackendModule(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  coreCompiled ??= compileGhosttyCore(ghosttyFixture);
  // Awaited by the first load; a failure here surfaces there, as a terminal
  // that cannot initialize.
  coreCompiled.catch(() => {});
  useGhosttyFixture({ opened: openedGhostty, reset: resetGhosttyFixture });
  return {
    ...actual,
    loadGhosttyKit: async (): Promise<GhosttyKit> => {
      await coreCompiled;
      return fixtureKit(actual.ghosttyKitFrom);
    },
  };
}

/// The `vi.mock("../terminal/ghosttyCompat", ...)` factory: jsdom has no font
/// metrics to align the widget's cells with.
export async function ghosttyCompatModule(importOriginal: <T>() => Promise<T>) {
  return { ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()), ...ghosttyCompatStubs() };
}

/// Mount `TerminalTab` for a seated tab, as `mountTerminal` does, and return
/// the fixture's widget it opened. Throws before mounting unless the file
/// declared the fixture, so a file whose mocks did not apply fails rather
/// than running on another terminal.
export async function mountGhosttyTerminal(
  TerminalTab: Component<any>,
  tab: TerminalTabState,
  props: { focused?: boolean; active?: boolean; side?: "a" | "b" } = {},
): Promise<{ target: HTMLElement; component: Record<string, unknown>; term: Terminal }> {
  if (!ghosttyFixtureDeclared()) {
    throw new Error(
      'mountGhosttyTerminal needs the shared fixture: vi.mock "../terminal/backend" with ghosttyBackendModule ' +
        'and "../terminal/ghosttyCompat" with ghosttyCompatModule',
    );
  }
  const { target, component } = await mountTerminal(TerminalTab, tab, props);
  return { target, component, term: await openedGhostty(target) };
}

/// The fixture terminal open inside `within`, once there is one.
export async function openedGhostty(within: Node = document): Promise<Terminal> {
  return vi.waitFor(
    () => {
      const term = ghosttyFixture.terminals.find((t) => t.element?.isConnected && within.contains(t.element));
      expect(term, "a Ghostty terminal opened through the shared fixture").toBeDefined();
      return term!;
    },
    { timeout: 5_000 },
  );
}

/// Type a key into the terminal: the keydown goes to the element the widget
/// focuses, where the app's key handling listens ahead of the widget's own.
/// What the key did is what the product shows for it: the input frames on
/// the terminal's socket, and whether the returned event's default action
/// was prevented.
export function pressInGhostty(term: Terminal, init: KeyboardEventInit): KeyboardEvent {
  if (!term.element) throw new Error("the Ghostty terminal is not open");
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  term.element.dispatchEvent(event);
  return event;
}

function resetGhosttyFixture(): void {
  ghosttyFixture.terminals.splice(0);
}

/// Data the terminal emits as typed input, as a key or a paste does.
export function typeInGhostty(term: Terminal, data: string): void {
  term.input(data, true);
}

/// Whether keyboard focus is inside the terminal: on its element, which
/// focus() takes, or its input textarea, which a press on the canvas takes.
export function ghosttyHasFocus(term: Terminal): boolean {
  const focused = document.activeElement;
  return !!term.element && !!focused && term.element.contains(focused);
}

function fixtureKit(kitFrom: typeof ghosttyKitFrom): GhosttyKit {
  if (!ghosttyFixture.module) throw new Error("the vendored core did not compile");
  class FixtureTerminal extends Terminal {
    #open = false;

    constructor(...args: ConstructorParameters<typeof Terminal>) {
      super(...args);
      ghosttyFixture.terminals.push(this);
    }

    override open(parent: HTMLElement): void {
      serveCanvases();
      this.#open = true;
      try {
        super.open(parent);
      } catch (error) {
        this.#close();
        throw error;
      }
    }

    override dispose(): void {
      super.dispose();
      this.#close();
    }

    #close(): void {
      if (!this.#open) return;
      this.#open = false;
      releaseCanvases();
    }
  }
  return kitFrom(ghosttyFixture.module, { Terminal: FixtureTerminal });
}

// jsdom implements no 2D context, and a test environment may answer with
// none at all. While a fixture terminal is open every canvas asked for a 2D
// context gets a software one, since the widget also measures its font on a
// detached canvas; any other context id gets the environment's own answer,
// and so does every canvas once the last terminal closes. A test that
// installed its own context (`installSoftwareCanvas`) keeps it.
const softwareContexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
let openTerminals = 0;
let environmentGetContext: typeof HTMLCanvasElement.prototype.getContext | null = null;
let servedGetContext: typeof HTMLCanvasElement.prototype.getContext | null = null;

function serveCanvases(): void {
  openTerminals += 1;
  const current = HTMLCanvasElement.prototype.getContext;
  if (current === servedGetContext || vi.isMockFunction(current)) return;
  environmentGetContext = current;
  servedGetContext = softwareGetContext(softwareContexts, current);
  HTMLCanvasElement.prototype.getContext = servedGetContext;
}

function releaseCanvases(): void {
  openTerminals -= 1;
  if (openTerminals > 0 || !environmentGetContext) return;
  if (HTMLCanvasElement.prototype.getContext === servedGetContext) {
    HTMLCanvasElement.prototype.getContext = environmentGetContext;
  }
  environmentGetContext = null;
  servedGetContext = null;
}
