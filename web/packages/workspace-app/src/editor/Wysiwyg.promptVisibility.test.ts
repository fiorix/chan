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

import { demoData, mountApp, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { draftPath, draftSeed } from "../__tests__/drafts";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { mouseDown, mouseUp } from "../__tests__/pointer";
import { settle } from "../__tests__/wysiwyg";
import { cancelPaneMode, enterPaneMode, flipHybrid, paneMode, selectTabInPane } from "../state/tabs.svelte";
import { hideRichPromptForTab, richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { openDateAtCaret } from "./commands/date_macros";

stubAppEnvironment();

const PANE = "prompt-pane";
const TERMINAL = "prompt-terminal";
const OTHER = "other-terminal";
const DOC = "See https://example.com here\n\nDate: 2026-11-02 today";
const OVERLAYS = ".md-bubble, .md-date-popover, .md-preview-popover";

afterEach(async () => {
  if (paneMode.active) cancelPaneMode();
  document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await unmountApp();
  richPrompt.byTab = {};
  richPrompt.sourceByTab = {};
  richPrompt.toolbarByTab = {};
  vi.restoreAllMocks();
});

type Overlay = "URL" | "date pill" | "caret calendar";

async function openOverlay(kind: Overlay): Promise<EditorView> {
  await mountApp({ ...demoData(), drafts: [draftSeed("prompt", { "draft.md": DOC })] });
  resetLayout([
    terminalTab({ id: TERMINAL, richPromptDraftPath: draftPath("prompt") }),
    terminalTab({ id: OTHER }),
  ], { id: PANE });
  showRichPromptForTab(TERMINAL);
  await settle();
  const content = document.querySelector<HTMLElement>(".terminal-composer .cm-content")!;
  expect(content, "the real terminal mounts its prompt editor").not.toBeNull();
  const view = EditorView.findFromDOM(content)!;
  expect(view.state.doc.toString()).toBe(DOC);
  view.dispatch({ selection: { anchor: 0 } });
  await settle();
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 10, right: 10, top: 10, bottom: 30 });
  if (kind === "caret calendar") {
    view.dispatch({ selection: { anchor: DOC.indexOf("2026") + 1 } });
    expect(openDateAtCaret(view)).toBe(true);
  } else {
    const el = content.querySelector<HTMLElement>(kind === "URL" ? ".cm-md-link" : ".cm-md-date-pill")!;
    expect(el).not.toBeNull();
    if (kind === "URL") vi.spyOn(view, "posAtCoords").mockReturnValue(DOC.indexOf("https") + 1);
    mouseDown(el);
    mouseUp(el);
  }
  await settle();
  expect(document.querySelectorAll(OVERLAYS)).toHaveLength(1);
  return view;
}

describe.each<Overlay>(["URL", "date pill", "caret calendar"])("Rich Prompt %s visibility", (kind) => {
  test("closes on a mouse-free tab switch while preserving the prompt editor", async () => {
    const view = await openOverlay(kind);
    selectTabInPane(PANE, OTHER);
    await settle();
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(0);
    expect(view.dom.isConnected, "the prompt remains mounted").toBe(true);
    expect(view.state.doc.toString()).toBe(DOC);
    selectTabInPane(PANE, TERMINAL);
    await settle();
    expect(EditorView.findFromDOM(view.contentDOM)).toBe(view);
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(0);
  });

  test("closes when its terminal's pane flips", async () => {
    await openOverlay(kind);
    flipHybrid(PANE);
    await settle();
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(0);
  });

  test("closes on Hybrid Nav entry", async () => {
    await openOverlay(kind);
    enterPaneMode();
    await settle();
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(0);
  });

  test("closes when the prompt is hidden", async () => {
    await openOverlay(kind);
    hideRichPromptForTab(TERMINAL);
    await settle();
    expect(document.querySelectorAll(OVERLAYS)).toHaveLength(0);
  });
});
