// @vitest-environment jsdom
//
// A slide deck follows a light/dark switch in its open preview and in the
// Outline's slide thumbnails. FileEditorTab hands the editor surface's theme
// to the preview (state/slidePreview.ts, whose update repaints its inline
// styles and redraws the slide) and to every thumbnail (SlideThumbnail
// re-renders its miniature when its theme changes). Fresh mounts in each
// theme give the reference; one mount then switches twice and must paint
// exactly that reference at each step. The diagram and Excalidraw renderers
// stand in with faces that name the theme they drew in.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import FileEditorTab from "./FileEditorTab.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { fileTab as harnessFileTab } from "../__tests__/tabs";
import { refreshWorkspace, ui } from "../state/store.svelte";
import { layout, type FileTab, type LeafNode } from "../state/tabs.svelte";

vi.mock("../editor/mermaid_render", () => ({
  renderMermaid: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg class="face-mermaid" data-drawn="${dark ? "dark" : "light"}"></svg>`,
  })),
  renderMermaidForClipboard: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));

vi.mock("../editor/excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async (_source: string, dark: boolean) => ({
    ok: true,
    svg: `<svg class="face-excalidraw-block" data-drawn="${dark ? "dark" : "light"}"></svg>`,
  })),
  renderExcalidrawForClipboard: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
  renderExcalidrawFile: vi.fn(async (_url: string, dark: boolean) => ({
    ok: true,
    svg: `<svg class="face-excalidraw" data-drawn="${dark ? "dark" : "light"}"></svg>`,
  })),
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
Element.prototype.scrollIntoView = () => {};
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
    dispatchEvent() {
      return false;
    },
  }),
});

/// Two slides: the first with a Mermaid diagram and a raster image, the
/// second with an Excalidraw board embedded as an image.
const DECK = [
  "---",
  "chan:",
  "  kind: slides",
  "---",
  "",
  "# Diagram",
  "",
  "```mermaid",
  "pie title Pets",
  '  "Dogs" : 3',
  "```",
  "",
  "![photo](photo.png)",
  "",
  '<hr class="chan-page-break">',
  "",
  "# Board",
  "",
  "![board](board.excalidraw)",
  "",
].join("\n");

type Theme = "light" | "dark";
const PANE = "deck-theme-pane";
const startTheme = ui.theme;
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: "talks/deck.md", kind: "document", size: DECK.length, mtime: 100, content: DECK }],
  });
  await refreshWorkspace();
  localStorage.clear();
});

afterEach(async () => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  await settle();
  uninstallDemoWorkspace();
  timers.release();
  ui.theme = startTheme;
  vi.clearAllMocks();
});

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function switchTo(theme: Theme): Promise<void> {
  ui.theme = theme;
  document.documentElement.dataset.theme = theme;
  await settle();
}

/// Seat the deck alone in a pane with its Outline and its preview open, and
/// mount the tab.
async function mountDeck(): Promise<Record<string, unknown>> {
  const tab = harnessFileTab({
    path: "talks/deck.md",
    mode: "source",
    content: DECK,
    saved: DECK,
    outlineOpen: true,
    slidePreview: { open: true, index: 0, mode: "preview" },
  });
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const live = (layout.nodes[PANE] as LeafNode).tabs[0] as FileTab;
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(FileEditorTab, { target, props: { tab: live, active: true, focused: false } });
  mounted.push(component);
  await settle();
  return component;
}

/// Wait until the preview and both thumbnails show their slides with every
/// face drawn in `theme`.
async function drawnIn(theme: Theme): Promise<void> {
  await vi.waitFor(() => {
    const backdrop = document.querySelector<HTMLElement>(".md-slide-preview");
    expect(backdrop?.dataset.theme, "the preview's theme").toBe(theme);
    const minis = [...document.querySelectorAll(".slide-miniature")];
    expect(minis, "one thumbnail per slide").toHaveLength(2);
    const faces = [
      ...(backdrop?.querySelectorAll("svg[data-drawn]") ?? []),
      ...minis.flatMap((m) => [...m.querySelectorAll("svg[data-drawn]")]),
    ];
    // The preview shows slide 1 (mermaid); the thumbnails show both slides
    // (mermaid, then the board).
    expect(faces.map((f) => f.getAttribute("class")).sort()).toEqual(["face-excalidraw", "face-mermaid", "face-mermaid"]);
    for (const face of faces) expect(face.getAttribute("data-drawn"), face.getAttribute("class")!).toBe(theme);
  }, { timeout: 5_000 });
  await settle();
}

/// What the deck paints: the preview's stage, page, nav and counter styles
/// and its slide's markup, and each thumbnail's miniature markup.
function paint(): Record<string, unknown> {
  const backdrop = document.querySelector<HTMLElement>(".md-slide-preview")!;
  const styleOf = (selector: string) => backdrop.querySelector<HTMLElement>(selector)?.style.cssText ?? "missing";
  return {
    theme: backdrop.dataset.theme,
    backdrop: backdrop.style.cssText,
    page: styleOf(".md-slide-preview-page"),
    prev: styleOf(".md-slide-preview-prev"),
    next: styleOf(".md-slide-preview-next"),
    counter: styleOf(".md-slide-preview-counter"),
    slide: backdrop.querySelector(".md-slide-preview-content")?.innerHTML ?? "missing",
    thumbnails: [...document.querySelectorAll(".slide-miniature")].map((m) => m.innerHTML),
  };
}

describe("a slide deck switched twice", () => {
  test.each([
    { order: ["light", "dark", "light"] as Theme[] },
    { order: ["dark", "light", "dark"] as Theme[] },
  ])("$order paints the preview and the thumbnails as a fresh mount in each theme", async ({ order }) => {
    const reference = {} as Record<Theme, Record<string, unknown>>;
    for (const theme of ["light", "dark"] as const) {
      await switchTo(theme);
      const fresh = await mountDeck();
      await drawnIn(theme);
      reference[theme] = paint();
      unmount(fresh);
      mounted.splice(mounted.indexOf(fresh), 1);
      document.body.innerHTML = "";
      await settle();
      expect(document.querySelector(".md-slide-preview"), "the fresh mount's preview closed").toBeNull();
    }
    expect(reference.light, "light and dark paint differently").not.toEqual(reference.dark);

    const [first, ...rest] = order as [Theme, ...Theme[]];
    await switchTo(first);
    await mountDeck();
    await drawnIn(first);
    expect(paint(), `mounted in ${first}`).toEqual(reference[first]);
    const backdrop = document.querySelector(".md-slide-preview");
    for (const theme of rest) {
      await switchTo(theme);
      await drawnIn(theme);
      expect(paint(), `after the switch to ${theme}`).toEqual(reference[theme]);
      expect(document.querySelector(".md-slide-preview"), "the same preview, not a new one").toBe(backdrop);
    }
  });
});
