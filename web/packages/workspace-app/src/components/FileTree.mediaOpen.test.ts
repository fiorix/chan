// @vitest-environment jsdom
//
// Double-clicking a Files row and pressing Enter on it do the same thing: a
// media file opens in its viewer, and anything else opens in an editor tab.
// Media rows answer both gestures; nothing gates them off.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { layout, openBrowserInActivePane, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "clip.mp4", kind: "binary", size: 10, mtime: 100 },
    ]),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("clip.mp4")).toBeDefined());
});

afterEach(async () => {
  document.querySelectorAll(".md-video-viewer").forEach((el) => el.remove());
  await unmountApp();
});

function row(path: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

function name(path: string): HTMLElement {
  return row(path)!.querySelector<HTMLElement>(".name")!;
}

function openFileTabs(): string[] {
  return (layout.nodes["pane-test"] as LeafNode).tabs.flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
}

describe("opening a Files row", () => {
  test("a double-click on a video opens the video viewer, not an editor", async () => {
    name("clip.mp4").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();

    expect(document.querySelector(".md-video-viewer")).not.toBeNull();
    expect(openFileTabs()).toEqual([]);
  });

  test("Enter on a selected video opens the viewer the same way", async () => {
    name("clip.mp4").click();
    await settle();

    document
      .querySelector(".tree")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();

    expect(document.querySelector(".md-video-viewer")).not.toBeNull();
    expect(openFileTabs()).toEqual([]);
  });

  test("a double-click on a document opens it in an editor tab", async () => {
    name("a.md").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    await vi.waitFor(() => expect(openFileTabs()).toEqual(["a.md"]));
    expect(document.querySelector(".md-video-viewer")).toBeNull();
  });
});
