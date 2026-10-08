// Stand-ins for what a canvas board loads when it mounts: the Excalidraw
// package and the React runtime it renders through. The real package's ESM
// build does not resolve under Node, so a board that loads it fails the run
// after the test that opened it. `standInForBoards` puts these in its place
// for every board opened from then on in the file; `mountApp` calls it, so a
// board opened in the mounted App always gets them. A test that opens a
// board waits for it with `boardLoaded`. A test that draws on a board opened
// in the mounted App hands it the library stand-in with `drawableBoards`.
//
// The two waits follow the stand-ins' own events: a root made, a board
// rendered. A board's modules load in the time the machine gives them, so a
// wait with a deadline of its own fails a correct test on a loaded one.
//
// This is not a setup-level mock: a test of the board itself, or of the
// excalidraw renderer, which falls back when the package fails to load,
// sees the modules it asks for unless it asks for these.

import { vi } from "vitest";

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

/// The props of the latest render of a board opened since `drawableBoards`.
let drawn: unknown = null;
/// Waits to end at the next React root a board creates.
let onRoot: Array<() => void> = [];
/// Waits to end at the next render of a drawable board.
let onDrawn: Array<() => void> = [];

function end(waits: Array<() => void>): void {
  for (const done of waits.splice(0)) done();
}

export const reactDom = {
  createRoot: vi.fn((_host?: unknown) => {
    end(onRoot);
    return { render: (_element?: unknown) => {}, unmount: () => {} };
  }),
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
  onRoot = [];
  onDrawn = [];
}

/// Wait until a board opened since `standInForBoards` has loaded and
/// created its React root. A board that never does leaves the test to its
/// own timeout.
export async function boardLoaded(): Promise<void> {
  if (reactDom.createRoot.mock.calls.length > 0) return;
  await new Promise<void>((resolve) => onRoot.push(resolve));
}

/// Hand every board opened from now on in this file the drawing library's
/// stand-in from `./excalidrawLibrary`, whose board a test draws on, in place
/// of the one above, which never hands its API over. Call it after
/// `mountApp`, before the board opens; the next `standInForBoards` puts the
/// one above back.
export function drawableBoards(): void {
  drawn = null;
  onDrawn = [];
  vi.doMock("@excalidraw/excalidraw", () => excalidrawModule);
  reactDom.createRoot.mockImplementation(() => {
    end(onRoot);
    return {
      render: (element: unknown) => {
        drawn = element;
        end(onDrawn);
      },
      unmount: () => {},
    };
  });
}

/// The board a drawable board's render built, once it has rendered.
export async function drawableBoard(): Promise<Board> {
  if (drawn === null) {
    await new Promise<void>((resolve) => onDrawn.push(resolve));
  }
  return excalidrawBoard(() => drawn!);
}
