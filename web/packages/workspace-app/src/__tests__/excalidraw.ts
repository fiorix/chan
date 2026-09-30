// Stand-ins for what a canvas board loads when it mounts: the Excalidraw
// package and the React runtime it renders through. The real package's ESM
// build does not resolve under Node, so a board that loads it fails the run
// after the test that opened it. `standInForBoards` puts these in its place
// for every board opened from then on in the file; `mountApp` calls it, so a
// board opened in the mounted App always gets them. A test that opens a
// board waits for it with `boardLoaded`. A test that draws on a board opened
// in the mounted App hands it the library stand-in with `drawableBoards`.
//
// This is not a setup-level mock: a test of the board itself, or of the
// excalidraw renderer, which falls back when the package fails to load,
// sees the modules it asks for unless it asks for these.

import { expect, vi } from "vitest";

import { excalidrawBoard, excalidrawModule, type Board } from "./excalidrawLibrary";

export const excalidraw = {
  Excalidraw: () => null,
  serializeAsJSON: (elements: unknown, appState: unknown) =>
    JSON.stringify({ elements, appState, files: {} }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", EVENTUALLY: "EVENTUALLY", NEVER: "NEVER" },
  reconcileElements: (local: readonly unknown[]) => [...local],
};

export const react = {
  Component: class {
    props: unknown;
    state: Record<string, unknown> = {};
    constructor(props: unknown) { this.props = props; }
  },
  createElement: (type: unknown, props: Record<string, unknown>, child?: unknown) =>
    ({ type, props: child === undefined ? props : { ...props, children: child } }),
};

export const reactDom = {
  createRoot: vi.fn((_host?: unknown) => ({ render: (_element?: unknown) => {}, unmount: () => {} })),
};

/// Stand in for the modules a board loads, for every board opened from now
/// on in this file, and load them now, so a board takes them from the module
/// cache and never has a load in flight when its test ends. Forgets the
/// roots earlier tests created, so `boardLoaded` waits for this test's, and
/// what `drawableBoards` put in their place.
export async function standInForBoards(): Promise<void> {
  vi.doMock("@excalidraw/excalidraw", () => excalidraw);
  vi.doMock("react", () => react);
  vi.doMock("react-dom/client", () => reactDom);
  await Promise.all([import("@excalidraw/excalidraw"), import("react"), import("react-dom/client")]);
  reactDom.createRoot.mockReset();
}

/// Wait until a board opened since `standInForBoards` has loaded and
/// created its React root.
export async function boardLoaded(): Promise<void> {
  await vi.waitFor(() => expect(reactDom.createRoot).toHaveBeenCalled());
}

/// The props of the latest render of a board opened since `drawableBoards`.
let drawn: unknown = null;

/// Hand every board opened from now on in this file the drawing library's
/// stand-in from `./excalidrawLibrary`, whose board a test draws on, in place
/// of the one above, which never hands its API over. Call it after
/// `mountApp`, before the board opens; the next `standInForBoards` puts the
/// one above back.
export function drawableBoards(): void {
  drawn = null;
  vi.doMock("@excalidraw/excalidraw", () => excalidrawModule);
  reactDom.createRoot.mockImplementation(() => ({
    render: (element: unknown) => {
      drawn = element;
    },
    unmount: () => {},
  }));
}

/// The board a drawable board's render built, once it has rendered.
export async function drawableBoard(): Promise<Board> {
  await vi.waitFor(() => expect(drawn).not.toBeNull());
  return excalidrawBoard(() => drawn!);
}
