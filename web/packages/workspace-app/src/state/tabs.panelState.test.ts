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

test("a dashboard's opened directories survive serialization, and none are saved once all are closed", async () => {
  await restoreLayout({ k: "l", t: [{ k: "d", cs: 1, de: ["docs", "docs/api", "notes"] }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["docs", "docs/api", "notes"]);
  await restoreLayout(serializeLayout()!);
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["docs", "docs/api", "notes"]);
  tab.indexingExpanded = undefined;
  expect((serializeLayout() as SerLeaf).t[0].de).toBeUndefined();
  tab.indexingExpanded = [];
  expect((serializeLayout() as SerLeaf).t[0].de).toBeUndefined();
  // An entry that is no directory path is dropped, and a repeat is kept once.
  await expect(restoreLayout({ k: "l", t: [{ k: "d", de: ["", 7, "docs", "docs"] as string[] }] })).resolves.toBeUndefined();
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["docs"]);
});

test("dashboard restore drops paths the index cannot list, keeping valid directory names", async () => {
  await restoreLayout({ k: "l", t: [{ k: "d", de: [
    "../docs", "docs/../notes", "..", "/docs", "docs//api", "docs/", "",
    "docs", "docs/api", "docs..old", "__proto__", "docs",
  ] }] });
  const tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["docs", "docs/api", "docs..old", "__proto__"]);
  expect((serializeLayout() as SerLeaf).t[0].de).toEqual(tab.indexingExpanded);
});

test("dashboard restore bounds opened directories after filtering and deduplication", async () => {
  const dirs = Array.from({ length: 300 }, (_, i) => `docs-${i}`);
  await restoreLayout({ k: "l", t: [{ k: "d", de: [
    ...Array<string>(300).fill("/invalid"), ...Array<string>(300).fill(dirs[0]), ...dirs,
  ] }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(dirs.slice(0, 256));
  await restoreLayout(serializeLayout()!);
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(dirs.slice(0, 256));
});

test("dashboard restore applies the same bound and path rules to selected ancestors", async () => {
  const path = Array<string>(300).fill("docs").join("/");
  await restoreLayout({ k: "l", t: [{ k: "d", dsi: `directory:${path}` }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(Array.from({ length: 256 }, (_, i) => Array<string>(i + 1).fill("docs").join("/")));

  await restoreLayout({ k: "l", t: [{ k: "d", de: ["notes"], dsi: "directory:docs/../hidden/leaf" }] });
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["notes", "docs"]);
});

test("a dashboard saved with a nested directory selected and none opened restores with the path to it opened", async () => {
  // A tab as a session holds it from when the Search slide drew the whole
  // tree: the selection alone, three levels down.
  await restoreLayout({ k: "l", t: [{ k: "d", cs: 1, dsi: "directory:docs/api/v1" }] });
  let tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingSelectedId).toBe("directory:docs/api/v1");
  expect(tab.indexingExpanded).toEqual(["docs", "docs/api"]);

  // A directory named for an Object member is a directory like any other.
  await restoreLayout({ k: "l", t: [{ k: "d", dsi: "directory:__proto__/a/b" }] });
  tab = activePane().tabs[0];
  if (tab.kind !== "dashboard") throw new Error("expected dashboard");
  expect(tab.indexingExpanded).toEqual(["__proto__", "__proto__/a"]);

  // A top-level selection, and the root's, need nothing opened.
  for (const selection of ["directory:docs", ""]) {
    await restoreLayout({ k: "l", t: [{ k: "d", dsi: selection }] });
    tab = activePane().tabs[0];
    if (tab.kind !== "dashboard") throw new Error("expected dashboard");
    expect(tab.indexingExpanded).toBeUndefined();
  }
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
