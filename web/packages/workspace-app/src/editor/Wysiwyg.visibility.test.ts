// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());
vi.mock("../components/canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

import { demoData, hostCommand, mountApp, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { mouseDown, mouseUp } from "../__tests__/pointer";
import { settle } from "../__tests__/wysiwyg";
import { api } from "../api/client";
import {
  cancelPaneMode, closePane, closeTab, enterPaneMode, flipHybrid, layout,
  moveTab, paneMode, selectTabInPane, setMode, type LeafNode,
} from "../state/tabs.svelte";
import { expandDateMacro, openDateAtCaret } from "./commands/date_macros";

stubAppEnvironment();

const PANE = "overlay-pane";
const OTHER_PANE = "other-pane";
const EDITOR = "overlay-editor";
const TERMINAL = "overlay-terminal";
const URL = "https://example.com/" + "a".repeat(180);
const DOC = `See ${URL}\n\nDate: 2026-11-02 today\n\nRead [[Note]] here\n\nEnd`;
const OVERLAYS = ".md-bubble, .md-date-popover, .md-preview-popover";

afterEach(async () => {
  if (paneMode.active) cancelPaneMode();
  // Also release the base implementation's leaked document listeners when
  // running these regressions red, before unmount clears their DOM.
  document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await unmountApp();
  vi.restoreAllMocks();
});

type Overlay = "URL" | "date pill" | "caret calendar" | "file preview";

function expectClosed(): void {
  expect(document.querySelectorAll(OVERLAYS), "hidden editor has no body overlay").toHaveLength(0);
  const anchors = [...document.body.children].filter(
    (el) => el instanceof HTMLElement && el.style.width === "1px" && el.style.pointerEvents === "none",
  );
  expect(anchors, "synthetic caret anchors are also released").toHaveLength(0);
}

async function openOverlay(kind: Overlay, split = false, beforeOpen?: () => void): Promise<EditorView> {
  await mountApp(demoData([
    { path: "editor.md", kind: "document", size: DOC.length, mtime: 100, content: DOC },
    { path: "Note.md", kind: "document", size: 6, mtime: 100, content: "# Note" },
  ]));
  resetLayout([
    fileTab({ id: EDITOR, path: "editor.md", content: DOC, saved: DOC, readMode: kind === "file preview" }),
    terminalTab({ id: TERMINAL }),
  ], { id: PANE });
  if (split) {
    layout.nodes[OTHER_PANE] = { kind: "leaf", id: OTHER_PANE, tabs: [], activeTabId: null };
    layout.nodes["split"] = { kind: "split", id: "split", direction: "row", a: PANE, b: OTHER_PANE, ratio: 0.5 };
    layout.rootId = "split";
  }
  await settle();
  const content = document.querySelector<HTMLElement>(`[data-pane-id="${PANE}"] .cm-content`)!;
  expect(content, "the real app mounts its editor").not.toBeNull();
  const view = EditorView.findFromDOM(content)!;
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 10, right: 10, top: 10, bottom: 30 });
  beforeOpen?.();

  if (kind === "URL") {
    const link = content.querySelector<HTMLElement>(".cm-md-link")!;
    expect(link, "the URL is rendered").not.toBeNull();
    vi.spyOn(view, "posAtCoords").mockReturnValue(DOC.indexOf(URL) + 1);
    mouseDown(link);
    mouseUp(link);
  } else if (kind === "caret calendar") {
    view.dispatch({ selection: { anchor: DOC.indexOf("2026") + 1 } });
    expect(openDateAtCaret(view)).toBe(true);
  } else {
    const selector = kind === "date pill" ? ".cm-md-date-pill" : ".cm-md-wiki-pill";
    const pill = content.querySelector<HTMLElement>(selector)!;
    expect(pill, "the clickable pill is rendered").not.toBeNull();
    mouseDown(pill);
    mouseUp(pill);
  }
  await settle();
  expect(document.querySelectorAll(OVERLAYS), `${kind} opens`).toHaveLength(1);
  return view;
}

describe.each<Overlay>(["URL", "date pill", "caret calendar", "file preview"])("%s visibility", (kind) => {
  test("closes on a host-command tab switch without mousedown and stays closed on return", async () => {
    const view = await openOverlay(kind);
    const mouse = vi.fn();
    document.addEventListener("mousedown", mouse);
    try {
      hostCommand("app.tab.next");
      await settle();
      expect((layout.nodes[PANE] as LeafNode).activeTabId).toBe(TERMINAL);
      expect(mouse).not.toHaveBeenCalled();
      expectClosed();
      selectTabInPane(PANE, EDITOR);
      await settle();
      expect(EditorView.findFromDOM(view.contentDOM), "the editor survives the switch").toBe(view);
      expectClosed();
    } finally {
      document.removeEventListener("mousedown", mouse);
    }
  });

  test("closes when its pane flips to the other side", async () => {
    await openOverlay(kind);
    flipHybrid(PANE);
    await settle();
    expect((layout.nodes[PANE] as LeafNode).side).toBe("b");
    expectClosed();
  });

  test("closes on Hybrid Nav entry", async () => {
    await openOverlay(kind);
    enterPaneMode();
    await settle();
    expect(paneMode.active).toBe(true);
    expectClosed();
  });

  test("closes when its editor tab is closed", async () => {
    await openOverlay(kind);
    await closeTab(PANE, EDITOR);
    await settle();
    expectClosed();
  });

  test("closes when its pane is closed", async () => {
    await openOverlay(kind);
    await closePane(PANE, { force: true });
    await settle();
    expectClosed();
  });

  test("stays open when another pane gains focus, then closes when its tab moves", async () => {
    const view = await openOverlay(kind, true);
    expect(view.dom.isConnected).toBe(true);
    layout.activePaneId = OTHER_PANE;
    await settle();
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(1);
    moveTab(PANE, EDITOR, OTHER_PANE);
    await settle();
    expectClosed();
  });
});

test("background document changes cannot open a hidden editor's bubble", async () => {
  const view = await openOverlay("URL");
  selectTabInPane(PANE, TERMINAL);
  await settle();
  const addition = "\n\nhttps://another.example.com";
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert: addition }, selection: { anchor: end + addition.length } });
  await settle();
  expect(view.state.doc.toString()).toBe(DOC + addition);
  expectClosed();
});

test("a hidden calendar releases its capture keys and cannot reopen from a stale command", async () => {
  const view = await openOverlay("caret calendar");
  selectTabInPane(PANE, TERMINAL);
  await settle();
  expect(openDateAtCaret(view)).toBe(true);
  await settle();
  expectClosed();
  const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  document.dispatchEvent(key);
  expect(key.defaultPrevented, "the hidden calendar no longer captures arrows").toBe(false);
});

test.each(["hidden", "closed", "replaced by source mode"])("a deferred date macro cannot open after its editor is %s", async (transition) => {
  const view = await openOverlay("URL");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "On @date" }, selection: { anchor: 8 } });
  await settle();
  const frames: FrameRequestCallback[] = [];
  const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  try {
    expect(expandDateMacro(view)).toBe(true);
    if (transition === "hidden") selectTabInPane(PANE, TERMINAL);
    else if (transition === "closed") await closeTab(PANE, EDITOR, { force: true });
    else setMode((layout.nodes[PANE] as LeafNode).tabs[0]!, "source");
    await settle();
    expect(frames.length, "the calendar waits for a frame").toBeGreaterThan(0);
    for (const callback of frames.splice(0)) callback(0);
  } finally {
    frame.mockRestore();
  }
  await settle();
  expectClosed();
});

test("a preview response arriving after the tab hides cannot restore the popover", async () => {
  const read = api.read;
  let finish: (() => void) | undefined;
  await openOverlay("file preview", false, () => {
    vi.spyOn(api, "read").mockImplementation((path) => path !== "Note.md" ? read(path) : new Promise((resolve, reject) => {
      finish = () => { void read(path).then(resolve, reject); };
    }));
  });
  expect(document.querySelector(".md-preview-body")?.textContent).toBe("loading...");
  selectTabInPane(PANE, TERMINAL);
  await settle();
  expect(finish).toBeDefined();
  finish!();
  await settle();
  expectClosed();
});
