// @vitest-environment jsdom
//
// A pick in the pane tree hands the keyboard to the picked tab's surface the
// way a press in its strip does: the focus pulse blurs the tree's filter and
// the surface of the newly focused tab takes the keyboard, in another pane
// and on the other side of a pane alike. The pane tree (Workspace, which
// draws the panes and docks their terminals) is mounted over the demo
// workspace with a terminal (the stand-in xterm) and real editors.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import Workspace from "./Workspace.svelte";
import PaneTreeOverlay from "./PaneTreeOverlay.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { demoSocketFactory } from "../demo/socket";
import { setSocketFactory } from "../api/transport";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { refreshTree, refreshWorkspace } from "../state/store.svelte";
import { closePaneTree, openPaneTree, paneTree } from "../state/paneTree.svelte";
import { layout, type FileTab, type LeafNode, type Node } from "../state/tabs.svelte";
import { fileTab as harnessFileTab } from "../__tests__/tabs";
import { installTerminalDom, resetTerminals, terminalTab, xterm, type FakeTerminal } from "../__tests__/terminalTab";

installTerminalDom();
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const RICH = "notes/plan.md";
const PLAIN = "notes/code.md";

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 2, textCount: 2 },
    files: [
      { path: RICH, kind: "document", size: 13, mtime: 1, content: "wysiwyg body\n" },
      { path: PLAIN, kind: "document", size: 12, mtime: 1, content: "source body\n" },
    ],
  });
  setSocketFactory(demoSocketFactory);
  await refreshWorkspace();
  await refreshTree();
});

afterEach(async () => {
  closePaneTree();
  for (const app of mounted.splice(0)) unmount(app);
  resetTerminals();
  await settle(2);
  uninstallDemoWorkspace();
  timers.release();
});

function fileTab(path: string, content: string, over: Partial<FileTab> = {}): FileTab {
  return harnessFileTab({ id: `file:${path}`, path, content, saved: content, ...over });
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// The text of the editor that holds the keyboard, or "" when none does.
function focusedEditor(): string {
  return document.activeElement?.closest(".cm-content")?.textContent ?? "";
}

/// A terminal pane on the left (active) beside an editor pane on the right
/// that shows the rich document and keeps the source-mode one on side B.
async function mountWindow(): Promise<FakeTerminal> {
  const nodes: Record<string, Node> = {
    root: { id: "root", kind: "split", direction: "row", a: "term-pane", b: "doc-pane", ratio: 0.5 },
    "term-pane": { kind: "leaf", id: "term-pane", tabs: [terminalTab({ id: "shell" })], activeTabId: "shell" },
    "doc-pane": {
      kind: "leaf",
      id: "doc-pane",
      tabs: [fileTab(RICH, "wysiwyg body\n")],
      activeTabId: `file:${RICH}`,
      bTabs: [fileTab(PLAIN, "source body\n", { mode: "source" })],
      bActiveTabId: `file:${PLAIN}`,
    },
  };
  layout.nodes = nodes;
  layout.rootId = "root";
  layout.activePaneId = "term-pane";
  const target = (): HTMLElement => document.body.appendChild(document.createElement("div"));
  mounted.push(mount(Workspace, { target: target() }));
  mounted.push(mount(PaneTreeOverlay, { target: target() }));
  await vi.waitFor(() => expect(xterm.terminals.length).toBeGreaterThan(0));
  await settle();
  return xterm.terminals.at(-1)!;
}

function filter(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[aria-label="Filter tabs"]')!;
}

async function pick(query: string): Promise<void> {
  openPaneTree();
  await settle(2);
  const input = filter();
  expect(document.activeElement, "the tree's filter holds the keyboard while it is open").toBe(input);
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
}

describe("a pick in the pane tree", () => {
  test("moves the keyboard from the terminal into the picked editor in another pane", async () => {
    const term = await mountWindow();
    const blurs = term.blurCount;

    await pick("plan");

    expect(paneTree.open).toBe(false);
    expect(layout.activePaneId).toBe("doc-pane");
    expect(focusedEditor()).toContain("wysiwyg body");
    expect(term.blurCount, "the terminal lets go of its xterm").toBeGreaterThan(blurs);
  });

  test("turns a pane to the picked tab's side and focuses that tab's editor", async () => {
    await mountWindow();

    await pick("code");

    const docPane = layout.nodes["doc-pane"] as LeafNode;
    expect([layout.activePaneId, docPane.side]).toEqual(["doc-pane", "b"]);
    expect(focusedEditor(), "the source-mode tab focuses its source editor").toContain("source body");
  });

  test("gives the keyboard back to the tab already shown when that tab is picked", async () => {
    await mountWindow();
    await pick("plan");
    expect(focusedEditor()).toContain("wysiwyg body");

    // Nothing about the layout changes, so only the focus pulse moves the
    // keyboard from the tree's filter back into the editor.
    await pick("plan");

    expect(layout.activePaneId).toBe("doc-pane");
    expect(focusedEditor()).toContain("wysiwyg body");
  });

  test("hands the keyboard back to the terminal when the terminal is picked from an editor", async () => {
    const term = await mountWindow();
    await pick("plan");
    expect(focusedEditor()).toContain("wysiwyg body");
    const focuses = term.focusCount;

    await pick("terminal");

    expect(layout.activePaneId).toBe("term-pane");
    expect(focusedEditor(), "the editor gives up the keyboard").toBe("");
    expect(term.focusCount, "the terminal takes it").toBeGreaterThan(focuses);
  });
});
