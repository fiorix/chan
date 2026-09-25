// @vitest-environment jsdom
//
// A file tab's editor stays mounted while another tab holds its pane (the
// pane keeps the instance across a switch; paneKeepAliveMount.test.ts
// compares the nodes). Only the live tab on the pane's visible side is
// active, and Hybrid Nav makes none active; an editor that is not active is
// hidden from assistive tech. Only the active editor of the focused pane
// takes the caret.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { demoData, mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { cancelPaneMode, layout, splitPane, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 5, mtime: 100, content: "alpha" },
      { path: "b.md", kind: "document", size: 4, mtime: 100, content: "beta" },
    ]),
  );
});

afterEach(async () => {
  cancelPaneMode();
  vi.restoreAllMocks();
  await unmountApp();
});

function editorOf(path: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>(".editor-tab")].find((editor) =>
    editor.textContent?.includes(path === "a.md" ? "alpha" : "beta"),
  )!;
}

async function seed(): Promise<void> {
  resetLayout([
    fileTab({ id: "a", path: "a.md", content: "alpha", saved: "alpha" }),
    fileTab({ id: "b", path: "b.md", content: "beta", saved: "beta" }),
  ]);
  await settle();
  await vi.waitFor(() => expect(document.querySelectorAll(".editor-tab .cm-content")).toHaveLength(2));
}

describe("a file tab's editor", () => {
  test("stays mounted and hidden while another tab holds the pane", async () => {
    await seed();

    expect(editorOf("a.md").getAttribute("aria-hidden")).toBe("false");
    expect(editorOf("a.md").classList.contains("active")).toBe(true);
    expect(editorOf("b.md").getAttribute("role")).toBe("tabpanel");
    expect(editorOf("b.md").getAttribute("aria-hidden")).toBe("true");
    expect(editorOf("b.md").classList.contains("active")).toBe(false);
  });

  test("is hidden during Hybrid Nav and back, the same editor, when it ends", async () => {
    await seed();
    const editor = editorOf("a.md");

    press({ key: ".", code: "Period", ctrlKey: true });
    await settle();
    expect(editor.getAttribute("aria-hidden")).toBe("true");

    press({ key: "Escape", code: "Escape" });
    await settle();
    expect(editorOf("a.md")).toBe(editor);
    expect(editor.getAttribute("aria-hidden")).toBe("false");
  });

  test("takes the caret only as the active tab of the focused pane", async () => {
    resetLayout([fileTab({ id: "a", path: "a.md", content: "alpha", saved: "alpha" })]);
    const other = splitPane("pane-test", "row")!;
    (layout.nodes[other] as LeafNode).tabs.push(fileTab({ id: "b", path: "b.md", content: "beta", saved: "beta" }));
    (layout.nodes[other] as LeafNode).activeTabId = "b";
    // The first pane, whose editor mounts first, holds the focus, so the
    // second pane's editor mounting after it must not take the caret.
    layout.activePaneId = "pane-test";
    await settle();
    await vi.waitFor(() => expect(document.querySelectorAll(".editor-tab .cm-content")).toHaveLength(2));

    await vi.waitFor(() => expect(editorOf("a.md").contains(document.activeElement)).toBe(true));
    expect(editorOf("b.md").contains(document.activeElement)).toBe(false);
  });
});
