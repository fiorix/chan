// @vitest-environment jsdom
//
// A media viewer answers its own keys, unmodified, and takes them before the
// app sees them. A chord with Ctrl, Cmd or Alt held is not the viewer's: it
// travels on to the app's window handler, so the app's chords work over an
// open viewer.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { pressInPage } from "./__tests__/keys";
import { openDiagramZoom } from "./state/diagramZoom";
import { searchPanel } from "./state/store.svelte";

stubAppEnvironment();

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

function diagramViewer(): HTMLElement | null {
  return document.querySelector(".md-diagram-zoom");
}

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  if (diagramViewer()) pressInPage({ key: "Escape" });
  searchPanel.open = false;
  await settle();
  await unmountApp();
});

describe("an app chord over the diagram viewer", () => {
  test("Ctrl+Alt+S opens Search, though S pans the diagram", async () => {
    openDiagramZoom(SVG);

    pressInPage({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    await settle();

    expect(searchPanel.open).toBe(true);
    expect(diagramViewer()).not.toBeNull();
  });
});
