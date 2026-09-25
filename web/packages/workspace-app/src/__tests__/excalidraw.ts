// Stand-ins for what a canvas board loads when it mounts: the Excalidraw
// package and the React runtime it renders through. The real package's ESM
// build does not resolve under Node, so a board opened in the mounted App
// fails its load after the test that opened it. A test that opens a board
// returns these from its own mocks, e.g.
//
//   vi.mock("@excalidraw/excalidraw", async () => (await import("./__tests__/excalidraw")).excalidraw);
//   vi.mock("react", async () => (await import("./__tests__/excalidraw")).react);
//   vi.mock("react-dom/client", async () => (await import("./__tests__/excalidraw")).reactDom);
//
// A board loads after it mounts. A test that opens one waits for
// `reactDom.createRoot` to be called before it ends, so no load is still
// pending when the file's mocks are torn down.
//
// This module imports nothing from the app, so a mock factory can load it
// while the app's own imports are still resolving.

import { vi } from "vitest";

export const excalidraw = {
  Excalidraw: () => null,
  serializeAsJSON: (elements: unknown, appState: unknown) =>
    JSON.stringify({ elements, appState, files: {} }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", EVENTUALLY: "EVENTUALLY", NEVER: "NEVER" },
  reconcileElements: (local: readonly unknown[]) => [...local],
};

export const react = {
  createElement: (type: unknown, props: unknown) => ({ type, props }),
};

export const reactDom = {
  createRoot: vi.fn(() => ({ render: () => {}, unmount: () => {} })),
};
