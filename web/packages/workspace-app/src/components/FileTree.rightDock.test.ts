// @vitest-environment jsdom
//
// A file browser docked on the right mirrors its tree so rows anchor against
// the edge they sit on: the tree takes the right-dock class, the indent moves
// to the right, and a collapsed directory's chevron points left, into the
// pane. A FileBrowserSurface is mounted over the demo workspace in each dock
// position.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import FileBrowserSurface from "./FileBrowserSurface.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshTree, refreshWorkspace, treeExpanded } from "../state/store.svelte";
import { layout, type BrowserTab } from "../state/tabs.svelte";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 2, textCount: 2 },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "README.md", kind: "document", size: 2, mtime: 100, content: "hi" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  treeExpanded.map = {};
});

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  for (let i = 0; i < 2; i += 1) await tick();
  uninstallDemoWorkspace();
  timers.release();
});

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props }));
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  return target;
}

function dirRow(target: HTMLElement, name: string): HTMLElement {
  const row = [...target.querySelectorAll<HTMLElement>("[role='treeitem']")].find(
    (el) => el.querySelector(".name")?.textContent?.trim() === `${name}/`,
  );
  if (!row) throw new Error(`no directory row ${name}`);
  return row;
}

function chevron(row: HTMLElement): string {
  const icon = row.querySelector(".twirl svg");
  return [...(icon?.classList ?? [])].find((c) => c.startsWith("lucide-chevron")) ?? "";
}

describe("a browser docked on the right", () => {
  test("mirrors the tree: right-dock class, indent on the right, a collapsed chevron pointing left", async () => {
    const target = await render({ variant: "dock", side: "right" });
    const tree = target.querySelector<HTMLElement>(".tree")!;
    expect(tree.classList.contains("right-dock")).toBe(true);

    const notes = dirRow(target, "notes");
    expect(notes.getAttribute("style")).toMatch(/^padding-right:/);
    expect(chevron(notes)).toBe("lucide-chevron-left");

    notes.querySelector<HTMLButtonElement>(".twirl")!.click();
    await tick();
    expect(chevron(dirRow(target, "notes")), "expanded points down on either side").toBe("lucide-chevron-down");
  });
});

describe("any other placement", () => {
  for (const [name, props] of [
    ["a browser docked on the left", { variant: "dock", side: "left" }],
    ["a Files tab", { variant: "tab" }],
  ] as const) {
    test(`${name} keeps the tree unmirrored`, async () => {
      const extra: Record<string, unknown> = {};
      if (props.variant === "tab") {
        const tab: BrowserTab = { kind: "browser", id: "fb-dock", title: "Files", inspectorOpen: false };
        layout.nodes = { p: { kind: "leaf", id: "p", tabs: [tab], activeTabId: tab.id } };
        layout.rootId = "p";
        layout.activePaneId = "p";
        extra.tab = tab;
      }
      const target = await render({ ...props, ...extra });
      expect(target.querySelector(".tree")!.classList.contains("right-dock")).toBe(false);
      const notes = dirRow(target, "notes");
      expect(notes.getAttribute("style")).toMatch(/^padding-left:/);
      expect(chevron(notes)).toBe("lucide-chevron-right");
    });
  }
});
