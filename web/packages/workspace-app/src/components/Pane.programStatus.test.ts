// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import Pane from "./Pane.svelte";
import { layout, tabTooltip, type LeafNode } from "../state/tabs.svelte";
import { terminalTab } from "../__tests__/tabs";
import type { ProgramStatusRecord } from "../state/programStatus";

class TestResizeObserver { observe() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((handle: number) => window.clearTimeout(handle)) as typeof cancelAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;

const mounted: Array<Record<string, unknown>> = [];
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
});

function record(partial: Partial<ProgramStatusRecord> = {}): ProgramStatusRecord {
  return { source: "program", id: null, state: "idle", kind: null, progress: null, app: null, title: null, msg: null, seen: false, update_order: 1, ...partial };
}

async function strip(records: ProgramStatusRecord[], activity = false) {
  const tab = terminalTab({ id: "status-tab", title: "Worker", terminalActivity: activity, programStatus: { revision: 3, records } });
  const pane: LeafNode = { kind: "leaf", id: "status-pane", tabs: [tab], activeTabId: tab.id };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane: layout.nodes[pane.id] as LeafNode } }));
  await tick();
  return { target, tab };
}

test("leading icon without working records", async () => {
  const { target } = await strip([record()]);
  expect(target.querySelector('[data-program-activity="icon"] svg')).not.toBeNull();
});

test("leading spinner for unmeasured work", async () => {
  const { target } = await strip([record({ state: "working" })]);
  expect(target.querySelector('[data-program-activity="spinner"] .spinner')).not.toBeNull();
});

test("leading ring prefers root progress even when root is blocked", async () => {
  const { target } = await strip([record({ state: "blocked", progress: 25 }), record({ id: "child", state: "working", progress: 70, update_order: 2 })]);
  expect(target.querySelector('[data-program-activity="ring"] [pathLength="100"]')?.getAttribute("stroke-dasharray")).toBe("25 100");
});

test("a reported zero is a ring at zero percent", async () => {
  const { target } = await strip([record({ state: "working", progress: 0 })]);
  expect(target.querySelector('[data-program-activity="ring"] [pathLength="100"]')?.getAttribute("stroke-dasharray")).toBe("0 100");
});

test("leading ring uses the newest working progress without root progress", async () => {
  const { target } = await strip([record({ state: "working" }), record({ id: "old", state: "working", progress: 20, update_order: 2 }), record({ id: "new", state: "working", progress: 70, update_order: 3 })]);
  expect(target.querySelector('[data-program-activity="ring"] [pathLength="100"]')?.getAttribute("stroke-dasharray")).toBe("70 100");
});

for (const [kind, shape] of [["permission", "shield"], ["question", null], ["auth", "key-round"], [null, "pause"]] as const) {
  test(`blocked ${kind ?? "other"} has its own shape`, async () => {
    const { target } = await strip([record({ state: "blocked", kind })]);
    expect(target.querySelector(`[data-program-attention="${kind ?? "other"}"] svg${shape ? `.lucide-${shape}` : ""}`)).not.toBeNull();
  });
}

test("error wins over done", async () => {
  const { target } = await strip([record({ state: "error" }), record({ id: "done", state: "done", update_order: 2 })]);
  expect(target.querySelector('[data-program-attention="error"] svg.lucide-circle-alert')).not.toBeNull();
});

test("unseen done uses a check shape", async () => {
  const { target } = await strip([record({ state: "done" })]);
  expect(target.querySelector('[data-program-attention="done"] svg.lucide-circle-check')).not.toBeNull();
});

test("attention states retain distinct outlines without their colors", async () => {
  const signatures: string[] = [];
  for (const [state, kind] of [["blocked", "permission"], ["blocked", "question"], ["blocked", "auth"], ["blocked", null], ["error", null], ["done", null]] as const) {
    const { target } = await strip([record({ state, kind })]);
    signatures.push(target.querySelector("[data-program-attention] svg")?.innerHTML ?? "");
  }
  expect(new Set(signatures).size).toBe(6);
});

test("a seen done and error produce no attention mark", async () => {
  const { target } = await strip([record({ state: "error", seen: true }), record({ id: "done", state: "done", seen: true, update_order: 2 })]);
  expect(target.querySelector('[data-program-attention="none"]')).not.toBeNull();
});

test("working root and blocked child occupy both places", async () => {
  const { target } = await strip([record({ state: "working" }), record({ id: "child", state: "blocked", kind: "question", update_order: 2 })]);
  expect([target.querySelector("[data-program-activity]")?.getAttribute("data-program-activity"), target.querySelector("[data-program-attention]")?.getAttribute("data-program-attention")]).toEqual(["spinner", "question"]);
});

test("unseen output dot remains for a tab with no records", async () => {
  const { target } = await strip([], true);
  expect(target.querySelector('[data-program-attention="output"] .activity')).not.toBeNull();
});

test("working status suppresses unrelated output dot", async () => {
  const { target } = await strip([record({ state: "working" })], true);
  expect([target.querySelector("[data-program-attention]")?.getAttribute("data-program-attention"), !!target.querySelector(".dirty.activity")]).toEqual(["none", false]);
});

test("idle status permits unrelated output dot", async () => {
  const { target } = await strip([record()], true);
  expect(target.querySelector('[data-program-attention="output"] .activity')).not.toBeNull();
});

test("tooltip disarms right to left, invisible formatting and HTML", async () => {
  const { tab } = await strip([record({ state: "blocked", title: "name\u202Eback", msg: "a\u200Bb<script>bad</script>" })]);
  const tooltip = tabTooltip(tab);
  expect(tooltip).toContain("name□back");
  expect(tooltip).toContain("a□b<script>bad</script>");
  expect(tooltip).not.toContain("\u202E");
  expect(tooltip).not.toContain("\u200B");
});
