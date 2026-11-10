// @vitest-environment jsdom
//
// A tap from a touch screen opens the Files row it lands on: a file opens in
// an editor tab, a folder is entered. A touch screen has no double click, and
// a phone's browser no room for the inspector a selection fills, so a tap
// that only selected did nothing anyone could see. A mouse click still only
// selects, and a tap with a modifier still only adds to the selection.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { browserSelection } from "../state/store.svelte";
import { layout, openBrowserInActivePane, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "docs/x.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a.md")).toBeDefined());
});

afterEach(async () => {
  await unmountApp();
});

function row(path: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

function openFileTabs(): string[] {
  return (layout.nodes["pane-test"] as LeafNode).tabs.flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
}

/// A pointer press and its click, as a finger or a mouse makes them.
async function press(target: HTMLElement, pointerType: "touch" | "mouse", init: MouseEventInit = {}): Promise<void> {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(down, "pointerType", { value: pointerType });
  target.dispatchEvent(down);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  await settle();
}

describe("a tap on a Files row", () => {
  test("opens a file in an editor tab", async () => {
    await press(row("a.md")!.querySelector<HTMLElement>(".name")!, "touch");
    await vi.waitFor(() => expect(openFileTabs()).toEqual(["a.md"]));
  });

  test("on the row outside its name opens it too", async () => {
    await press(row("b.md")!, "touch");
    await vi.waitFor(() => expect(openFileTabs()).toEqual(["b.md"]));
  });

  test("enters a folder", async () => {
    expect(row("x.md")).toBeUndefined();
    await press(row("docs")!.querySelector<HTMLElement>(".name")!, "touch");
    await vi.waitFor(() => expect(row("x.md")).toBeDefined());
  });

  test("from a mouse only selects", async () => {
    await press(row("a.md")!.querySelector<HTMLElement>(".name")!, "mouse");
    expect(browserSelection.path).toBe("a.md");
    expect(openFileTabs()).toEqual([]);
  });

  test("with a modifier only adds to the selection", async () => {
    await press(row("a.md")!.querySelector<HTMLElement>(".name")!, "mouse");
    await press(row("b.md")!.querySelector<HTMLElement>(".name")!, "touch", { metaKey: true });
    expect(openFileTabs()).toEqual([]);
  });
});
