// @vitest-environment jsdom
//
// A graph tab's opened directories are saved with the window's session, as
// the rest of the tab is, so a window reopened from its session, or the
// desktop after a restart, draws the tree the user left: a hide or close the
// desktop makes runs no page code, so what the session holds by then is what
// comes back. The app is mounted over the demo transport with the graph's
// canvas replaced by a probe the test drives as the user does: a click
// selects a node, a double-click on a directory opens or closes it, and the
// depth commands move the selected directory's depth. What the session save
// sends is read from its request.

import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());
vi.mock("./components/GraphCanvas.svelte", async () =>
  (await import("./__tests__/graphPanel")).canvasProbeModule(),
);

import { api } from "./api/client";
import { demoData, hostCommand, mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { canvas } from "./__tests__/graphPanel";
import { resetLayout } from "./__tests__/tabs";
import { openFsGraphForDirectory } from "./state/store.svelte";
import type { SerNode, SerTab } from "./state/tabs.svelte";

stubAppEnvironment();

const FILES = ["notes/a.md", "notes/deep/b.md", "src/main.rs", "src/lib/x.rs"].map((path) => ({
  path,
  kind: path.endsWith(".md") ? ("document" as const) : ("text" as const),
  size: 1,
  mtime: 1,
  content: "x",
}));

/// Longer than the session save's debounce, and its write.
const SAVED_WITHIN_MS = 3_000;

let save: MockInstance<typeof api.putSession>;

beforeEach(async () => {
  await mountApp(demoData(FILES));
  resetLayout([]);
  await settle();
  save = vi.spyOn(api, "putSession");
});

afterEach(async () => {
  await unmountApp();
  vi.restoreAllMocks();
});

function graphTabOf(node: SerNode | null | undefined): SerTab | null {
  if (!node) return null;
  if (node.k === "s") return graphTabOf(node.a) ?? graphTabOf(node.b);
  return [...node.t, ...(node.bt ?? [])].find((tab) => tab.k === "g") ?? null;
}

/// The graph tab as the last session save sent it.
function lastSaved(): SerTab | null {
  const call = save.mock.calls.at(-1);
  return call ? graphTabOf((call[0] as { layout?: SerNode }).layout) : null;
}

/// Wait until the last save sent says what `accept` asks of the graph tab.
async function savedWith(accept: (tab: SerTab) => boolean, what: string): Promise<SerTab> {
  await vi.waitFor(
    () => {
      const tab = lastSaved();
      if (!tab || !accept(tab)) throw new Error(`no save yet ${what}: ${JSON.stringify(tab)}`);
    },
    { timeout: SAVED_WITHIN_MS, interval: 50 },
  );
  return lastSaved()!;
}

const opened = (tab: SerTab, dir: string) => (tab.ge ?? []).includes(dir);

describe("a graph tab's opened directories", () => {
  test("are saved when the depth moves and when the selected directory is double-clicked", async () => {
    openFsGraphForDirectory("notes");
    await vi.waitFor(() => expect(canvas.props?.selectedId).toBe("directory:notes"), { timeout: SAVED_WITHIN_MS });
    await savedWith((tab) => tab.gn === "directory:notes", "of the selection");

    // The depth of the selected directory, one level more: notes/deep opens.
    hostCommand("app.graph.depth.increase");
    await settle();
    await savedWith((tab) => opened(tab, "notes/deep"), "with notes/deep opened");

    // Another directory: a click selects it, which the session saves, and a
    // double-click on it then opens it.
    canvas.props!.onSelect("directory:src");
    await savedWith((tab) => tab.gn === "directory:src", "of the new selection");
    canvas.props!.onSelect("directory:src");
    canvas.props!.onSetAsScope();
    await settle();
    const tab = await savedWith((tab) => opened(tab, "src"), "with src opened");
    expect(opened(tab, "notes/deep"), "what was opened before stays").toBe(true);
  });

  test("opened and closed in quick succession cost one save", async () => {
    openFsGraphForDirectory("notes");
    await vi.waitFor(() => expect(canvas.props?.selectedId).toBe("directory:notes"), { timeout: SAVED_WITHIN_MS });
    canvas.props!.onSelect("directory:src");
    await savedWith((tab) => tab.gn === "directory:src", "of the selection");
    const before = save.mock.calls.length;

    // Open, close, open: three double-clicks well inside the debounce.
    for (let i = 0; i < 3; i += 1) {
      canvas.props!.onSelect("directory:src");
      canvas.props!.onSetAsScope();
      await settle();
    }
    const tab = await savedWith((tab) => opened(tab, "src"), "with src opened");
    expect(tab.gn).toBe("directory:src");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(save.mock.calls.length - before, "one write for the burst").toBe(1);
  });
});
