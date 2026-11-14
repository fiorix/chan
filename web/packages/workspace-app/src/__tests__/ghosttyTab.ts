// A real Ghostty widget and vendored core behind TerminalTab's mocked
// loader. No component or backend value is imported here: mock factories
// can load this module while those modules are still initializing.

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { mount, type Component } from "svelte";
import { expect, vi } from "vitest";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import type { GhosttyKit, ghosttyKitFrom } from "../terminal/backend";
import { SoftwareCanvasContext } from "./softwareCanvas";
import { attach, receive, TERMINAL_PANE, TerminalSocket } from "./terminalTab";

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
    gateGhosttyScrollbarClicks: () => () => {},
  };
}

/// The caller owns mock/global restoration. Frames advance only by frame().
export function installSoftwareCanvas() {
  const contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) contexts.set(this, (context = new SoftwareCanvasContext(this, 8)));
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
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
