// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { persistStateToHash, searchPanel } from "./state/store.svelte";
import { layout, setActivePane, splitPane, type LeafNode } from "./state/tabs.svelte";

stubAppEnvironment();
let right: string;

beforeEach(async () => {
  await mountApp();
  const left = resetLayout([fileTab({ id: "left-file", path: "README.md", mode: "source" })]);
  right = splitPane(left.id, "row")!;
  const pane = layout.nodes[right] as LeafNode;
  pane.tabs.push(fileTab({ id: "right-file", path: "README.md", mode: "source" }));
  pane.activeTabId = "right-file";
  setActivePane(left.id);
  await settle();
  persistStateToHash();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  persistStateToHash();
  vi.useRealTimers();
  await unmountApp();
  vi.restoreAllMocks();
});

test("the mounted App puts a focused pane in the reload URL by the end of its event", async () => {
  const before = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s")!);
  expect(before.a.f, "the initial reload address focuses the left pane").toBe(1);
  const writes = vi.spyOn(history, "replaceState");

  setActivePane(right);
  await settle();
  await Promise.resolve();

  expect(document.querySelector(`.pane[data-pane-id="${right}"]`)?.classList.contains("focused")).toBe(true);
  const after = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s")!);
  expect(after.b.f, "a reload between this event and the 150 ms timer must keep the focused pane").toBe(1);
  expect(after.a.f).toBeUndefined();
  expect(writes).toHaveBeenCalledTimes(1);
});

test("the mounted App uses reserved capacity on unload and deduplicates pagehide", async () => {
  const writes = vi.spyOn(history, "replaceState");
  searchPanel.open = true;
  for (let change = 0; change < 100; change++) {
    searchPanel.query = `burst-${change}`;
    persistStateToHash();
  }
  await settle();
  const admitted = writes.mock.calls.length;
  expect(admitted).toBeGreaterThan(0);
  expect(admitted).toBeLessThanOrEqual(80);

  setActivePane(right);
  await settle();
  await Promise.resolve();
  expect(writes).toHaveBeenCalledTimes(admitted);
  const before = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s")!);
  expect(before.a.f, "ordinary capacity is exhausted").toBe(1);

  window.dispatchEvent(new Event("beforeunload"));
  const after = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s")!);
  expect(after.b.f, "the mounted unload handler opts into reserved capacity").toBe(1);
  expect(writes).toHaveBeenCalledTimes(admitted + 1);
  window.dispatchEvent(new Event("pagehide"));
  expect(writes, "the second lifecycle event writes no equal URL").toHaveBeenCalledTimes(admitted + 1);
});
