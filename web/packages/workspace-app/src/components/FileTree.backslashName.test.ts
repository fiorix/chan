// @vitest-environment jsdom
//
// On a Unix server `\` is a character of a name, and a workspace path is
// separated by `/` alone. A file named `a\b.md` is listed, opened and titled
// by its whole name, at the workspace root and inside a folder.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { workspace } from "../state/store.svelte";
import { layout, openBrowserInActivePane, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a\\b.md", kind: "document", size: 4, mtime: 100, content: "root" },
      { path: "dir/a\\b.md", kind: "document", size: 6, mtime: 100, content: "nested" },
    ]),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a\\b.md")).toBeDefined());
});

afterEach(async () => {
  await unmountApp();
});

/// The row whose title names exactly `path`: a row's title is the path
/// under the workspace root, so `a\b.md` is not matched by `dir/a\b.md`.
function row(path: string): HTMLElement | undefined {
  const root = workspace.info?.root?.replace(/\/+$/, "") ?? "";
  const title = root ? `${root}/${path}` : path;
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (el) => el.title.replace(/ \(.*\)$/, "") === title,
  );
}

function rowName(path: string): string {
  return row(path)!.querySelector<HTMLElement>(".name")!.textContent!.trim();
}

function tabStrip(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".tab .path")].map((el) => el.textContent!.trim());
}

function openFileTabs(): string[] {
  return (layout.nodes["pane-test"] as LeafNode).tabs.flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
}

describe("a file named a\\b.md", () => {
  test("is listed by its whole name at the root and inside a folder", async () => {
    expect(rowName("a\\b.md")).toBe("a\\b.md");

    row("dir")!.querySelector<HTMLButtonElement>("button.twirl")!.click();
    await vi.waitFor(() => expect(row("dir/a\\b.md")).toBeDefined());
    expect(rowName("dir/a\\b.md")).toBe("a\\b.md");
  });

  test("opens from its row into a tab titled by its whole name", async () => {
    row("a\\b.md")!.querySelector<HTMLElement>(".name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    await vi.waitFor(() => expect(openFileTabs()).toEqual(["a\\b.md"]));
    await vi.waitFor(() => expect(tabStrip()).toContain("a\\b.md"));
  });
});
