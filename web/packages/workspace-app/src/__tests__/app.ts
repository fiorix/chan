// Mount the real App over the in-memory demo transport and drive it the way
// the user and the desktop host do: key chords on the document and
// `chan:command` events on the window.
//
// A test file still declares its own `vi.mock` calls (the xterm packages
// from `./xterm`, the canvas runners from `./canvas`): vitest hoists a mock
// only in the file that writes it.

import { mount, tick } from "svelte";
import { vi } from "vitest";

import App from "../App.svelte";
import type { Preferences } from "../api/types";
import type { MockWorkspaceData } from "../demo/data";
import { demoTransportSettled, installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers, type TimerTrack } from "../demo/timers";
import "../state/commands/install";

/// The browser surface jsdom lacks and the app reaches for at mount: resize
/// observation, animation frames (run synchronously), a canvas context, font
/// loading and media queries.
export function stubAppEnvironment(): void {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof requestAnimationFrame;
  HTMLCanvasElement.prototype.getContext = (() =>
    ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
}

/// A one-document demo workspace.
export function demoData(
  files: MockWorkspaceData["files"] = [
    { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
  ],
): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: files.length,
      textCount: files.length,
    },
    files,
  };
}

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack | null = null;

/// Install the demo workspace, mount the app, and wait for its bootstrap.
/// `preferences` overrides the demo server's saved preferences. Pair with
/// `unmountApp` in `afterEach`. Timers the app arms from here
/// on are tracked and released at unmount, so mount with real timers
/// installed; a test may switch to fake ones after mounting and must switch
/// back before `unmountApp`.
export async function mountApp(
  data: MockWorkspaceData = demoData(),
  opts: { preferences?: Partial<Preferences> } = {},
): Promise<HTMLElement> {
  timers ??= trackTimers();
  installDemoWorkspace(data, opts);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }) as Record<string, unknown>);
  // Bootstrap runs a chain of requests; a test that seeds the layout before
  // it finishes would have the restore write over it.
  await demoTransportSettled();
  await settle();
  return target;
}

/// Let pending reactive updates and their follow-up microtasks run.
export async function settle(): Promise<void> {
  await tick();
  await tick();
}

/// Tear down every app `mountApp` mounted, with the demo transport's
/// teardown, and clear the document.
export async function unmountApp(): Promise<void> {
  try {
    await teardownDemoApp({ mounted, timers });
  } finally {
    timers = null;
    document.body.innerHTML = "";
  }
}

/// Press a key on the document, where the app's chord listeners sit.
export function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

/// Send a host command, the way chan-desktop and the native menu do.
export function hostCommand(name: string, detail: Record<string, unknown> = {}): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { ...detail, name } }));
}
