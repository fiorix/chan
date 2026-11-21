// @vitest-environment jsdom
//
// The tap rules a real touch session cannot pin: a press on a row outside its
// name, the exact spacing of the taps after a folder is entered, the double
// click a browser can make of two taps, and a modifier on a touch press. The
// browser check `320-files-touch` drives the rest with real touch input.

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
  await showDetails(false);
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

async function showDetails(open: boolean): Promise<void> {
  const tab = (layout.nodes["pane-test"] as LeafNode).tabs.find((candidate) => candidate.kind === "browser");
  if (tab?.kind === "browser") tab.inspectorOpen = open;
  await settle();
}

/// A pointer press and its click, as a finger or a mouse makes them. `at` is
/// the click's event time, for the taps whose spacing matters.
async function press(
  target: HTMLElement,
  pointerType: "touch" | "mouse",
  init: MouseEventInit = {},
  at?: number,
): Promise<void> {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(down, "pointerType", { value: pointerType });
  target.dispatchEvent(down);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  if (at !== undefined) Object.defineProperty(click, "timeStamp", { value: at });
  target.dispatchEvent(click);
  await settle();
}

describe("a tap on a Files row", () => {
  test("on the row outside its name opens it", async () => {
    await press(row("b.md")!, "touch");
    await vi.waitFor(() => expect(openFileTabs()).toEqual(["b.md"]));
  });

  test("right after entering a folder opens nothing, and a later one opens", async () => {
    await press(row("docs")!.querySelector<HTMLElement>(".name")!, "touch", {}, 1000);
    await vi.waitFor(() => expect(row("x.md")).toBeDefined());
    const name = row("x.md")!.querySelector<HTMLElement>(".name")!;
    await press(name, "touch", {}, 1399);
    name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await settle();
    expect(openFileTabs()).toEqual([]);
    await press(name, "touch", {}, 1400);
    await vi.waitFor(() => expect(openFileTabs()).toEqual(["docs/x.md"]));
  });

  test("a double tap with Details open opens the row", async () => {
    await showDetails(true);
    const name = row("a.md")!.querySelector<HTMLElement>(".name")!;
    await press(name, "touch");
    name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(openFileTabs()).toEqual(["a.md"]));
  });

  test("with a modifier only adds to the selection", async () => {
    await press(row("a.md")!.querySelector<HTMLElement>(".name")!, "mouse");
    await press(row("b.md")!.querySelector<HTMLElement>(".name")!, "touch", { metaKey: true });
    expect([...browserSelection.paths].sort()).toEqual(["a.md", "b.md"]);
    expect(openFileTabs()).toEqual([]);
  });
});
