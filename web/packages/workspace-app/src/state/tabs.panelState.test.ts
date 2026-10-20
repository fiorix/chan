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
