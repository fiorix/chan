// @vitest-environment jsdom

import { expect, test } from "vitest";
import { activePane, restoreLayout, serializeLayout, type SerLeaf } from "./tabs.svelte";

test.each([false, true])("terminal Program status visibility=%s and width survive serialization", async (open) => {
  await restoreLayout({ k: "l", t: [{ k: "t", n: "Worker", ...(open ? { o: 1 } : {}), iw: 310 }] });
  const first = activePane().tabs[0];
  expect(first).toMatchObject({ kind: "terminal", inspectorOpen: open, inspectorWidth: 310 });
  await restoreLayout(serializeLayout()!);
  expect(activePane().tabs[0]).toMatchObject({ kind: "terminal", inspectorOpen: open, inspectorWidth: 310 });
});

test.each([null, "", "directory:notes"])("dashboard Details selection %s and width survive serialization", async (selection) => {
  await restoreLayout({ k: "l", t: [{ k: "d", cs: 1, ...(selection !== null ? { dsi: selection } : {}), iw: 350 }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingSelectedId ?? null).toBe(selection);
  expect(tab.inspectorWidth).toBe(350);
  await restoreLayout(serializeLayout()!);
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingSelectedId ?? null).toBe(selection);
  expect(tab.inspectorWidth).toBe(350);
  tab.indexingSelectedId = null;
  expect((serializeLayout() as SerLeaf).t[0].dsi).toBeUndefined();
  await restoreLayout(serializeLayout()!);
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingSelectedId ?? null).toBeNull();
});

test("a graph tab saved with a scope of its own restores as the workspace with that node selected", async () => {
  // Tabs as a session holds them from when a graph could be scoped to a
  // node, or be the filesystem's (`gm: "f"`) or a language's (`gm: "l"`).
  await restoreLayout({
    k: "l",
    t: [
      { k: "g", gm: "s", gs: "dir:notes/sub", gf: "" },
      // The selection the tab was saved with wins over the scope's own node.
      { k: "g", gm: "s", gs: "tag:#t", gn: "notes/a.md", gnl: "a.md", gf: "" },
      { k: "g", gm: "s", gs: "language:Rust", gf: "" },
      // The filesystem graph named a directory by its bare path.
      { k: "g", gm: "f", gs: "dir:notes", gn: "notes", gf: "" },
      { k: "g", gm: "l", gs: "workspace", gd: 0, gf: "" },
    ],
  });
  const [dir, tag, language, fs, languages] = activePane().tabs;
  expect(dir).toMatchObject({
    kind: "graph",
    title: "path=workspace",
    pendingSelectId: "notes/sub",
    expanded: { "": true, notes: true, "notes/sub": true },
  });
  expect(tag).toMatchObject({ pendingSelectId: "notes/a.md", selectedNodeId: "notes/a.md" });
  expect(language).toMatchObject({ pendingSelectId: "language:Rust" });
  expect(fs).toMatchObject({ pendingSelectId: "notes", expanded: { "": true, notes: true } });
  expect(languages).toMatchObject({ title: "path=workspace", pendingSelectId: null });

  // Saved again, the tabs are the one graph: neither a mode nor a scope is
  // written.
  for (const saved of (serializeLayout() as SerLeaf).t) {
    expect("gm" in saved || "gs" in saved).toBe(false);
  }
});

test("a graph tab's selection of the workspace's own node survives serialization", async () => {
  // The root's node id is the empty string.
  await restoreLayout({ k: "l", t: [{ k: "g", gn: "", gnl: "notes", gf: "" }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "graph") throw new Error("expected graph");
  expect([tab.selectedNodeId, tab.pendingSelectId]).toEqual(["", ""]);

  const saved = (serializeLayout() as SerLeaf).t[0];
  expect([saved.gn, saved.gp]).toEqual(["", ""]);
  await restoreLayout(serializeLayout()!);
  tab = activePane().tabs[0];
  if (tab.kind !== "graph") throw new Error("expected graph");
  expect([tab.selectedNodeId, tab.pendingSelectId]).toEqual(["", ""]);

  // Nothing selected stays nothing selected.
  tab.selectedNodeId = null;
  tab.pendingSelectId = null;
  const cleared = (serializeLayout() as SerLeaf).t[0];
  expect("gn" in cleared || "gp" in cleared).toBe(false);
});
