// @vitest-environment jsdom
//
// The Files tree draws each path once. A listing can name the same entry
// twice (two merges racing), and a folder can arrive as its own entry after
// a file inside it already implied it; neither doubles a row.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { tree } from "../state/store.svelte";
import { openBrowserInActivePane } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(demoData([{ path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" }]));
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(rows("a.md")).toBe(1));
});

afterEach(async () => {
  await unmountApp();
});

function row(path: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

function rows(path: string): number {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  }).length;
}

describe("the Files tree", () => {
  test("draws a path the listing names twice once", async () => {
    const entry = tree.entries.find((candidate) => candidate.path === "a.md")!;
    tree.entries = [...tree.entries, { ...entry }];
    await settle();

    expect(rows("a.md")).toBe(1);
  });

  test("draws a folder once when its own entry follows a file inside it", async () => {
    tree.entries = [
      ...tree.entries,
      { path: "docs/b.md", is_dir: false, kind: "document", size: 5, mtime: 100 },
      { path: "docs", is_dir: true, size: 0, mtime: 100 },
    ];
    await settle();
    row("docs")!.querySelector<HTMLButtonElement>("button.twirl")!.click();
    await settle();

    expect(rows("docs")).toBe(1);
    expect(rows("docs/b.md")).toBe(1);
  });
});
