import { expect, test } from "vitest";
import { terminalTab } from "../__tests__/tabs";
import type { Node, SplitNode } from "./tabs.svelte";
import type { TmuxLayoutNode } from "./tmux";
import { tmuxResizeForSplit } from "./tmuxResize";

const leaf = (id: string, session: string, pane: string): Node => ({
  kind: "leaf",
  id,
  activeTabId: `tab-${id}`,
  tabs: [terminalTab({ id: `tab-${id}`, terminalSessionId: session, tmuxPane: { connection: 1, pane } })],
});
const split = (id: string, a: string, b: string, direction: SplitNode["direction"], ratio: number): SplitNode => ({
  id, kind: "split", a, b, direction, ratio,
});
const pane = (session: string, w: number, h: number): TmuxLayoutNode => ({ kind: "pane", session, w, h });

test("a horizontal divider targets the first side and rounds its width over the window grid without its border", () => {
  const root = split("root", "left", "right", "row", 0.6);
  const nodes = { root, left: leaf("left", "s0", "%0"), right: leaf("right", "s1", "%1") };
  const tree: TmuxLayoutNode = { kind: "row", w: 120, h: 40, children: [pane("s0", 60, 40), pane("s1", 59, 40)] };
  expect(tmuxResizeForSplit(root, nodes, tree, 0.6)).toEqual({
    sessionId: "s0", request: { request: "resize-pane", pane: "%0", axis: "width", cells: 71 },
  });
});

test("a vertical divider inside a first-side subtree sizes its own grid", () => {
  const root = split("root", "inner", "right", "row", 0.5);
  const inner = split("inner", "top", "bottom", "column", 0.65);
  const nodes = { root, inner, top: leaf("top", "s0", "%0"), bottom: leaf("bottom", "s2", "%2"), right: leaf("right", "s1", "%1") };
  const tree: TmuxLayoutNode = {
    kind: "row", w: 120, h: 40,
    children: [
      { kind: "column", w: 60, h: 40, children: [pane("s0", 60, 25), pane("s2", 60, 14)] },
      pane("s1", 59, 40),
    ],
  };
  expect(tmuxResizeForSplit(inner, nodes, tree, 0.65)).toEqual({
    sessionId: "s0", request: { request: "resize-pane", pane: "%0", axis: "height", cells: 25 },
  });
  expect(tmuxResizeForSplit(root, nodes, tree, 0.6)).toEqual({
    sessionId: "s0", request: { request: "resize-pane", pane: "%0", axis: "width", cells: 71 },
  });
});

test("the second divider of an n-ary row uses the remaining cells", () => {
  const outer = split("outer", "first", "rest", "row", 0.33);
  const inner = split("inner", "second", "third", "row", 0.6);
  const nodes = { outer, inner, first: leaf("first", "s0", "%0"), rest: inner, second: leaf("second", "s1", "%1"), third: leaf("third", "s2", "%2") };
  const tree: TmuxLayoutNode = { kind: "row", w: 120, h: 40, children: [pane("s0", 39, 40), pane("s1", 39, 40), pane("s2", 40, 40)] };
  expect(tmuxResizeForSplit(inner, nodes, tree, 0.6)).toEqual({
    sessionId: "s1", request: { request: "resize-pane", pane: "%1", axis: "width", cells: 47 },
  });
});

test("a missing first-side pane session cannot send a resize", () => {
  const root = split("root", "left", "right", "row", 0.6);
  const nodes = { root, left: leaf("left", "s0", "%0"), right: leaf("right", "s1", "%1") };
  const tree: TmuxLayoutNode = { kind: "row", w: 120, h: 40, children: [pane("s0", 60, 40), pane("s1", 59, 40)] };
  const left = nodes.left;
  if (left.kind !== "leaf") throw new Error("not a leaf");
  const tab = left.tabs[0];
  if (tab?.kind !== "terminal") throw new Error("not a terminal");
  tab.terminalSessionId = undefined;
  expect(tmuxResizeForSplit(root, nodes, tree, 0.6)).toBeNull();
});

test("the last cell on the second side reaches a divider hidden by same-axis splits on the first", () => {
  const root = split("root", "left", "right", "row", 0.6);
  const left = split("left", "top", "bottom", "column", 0.5);
  const top = split("top", "a", "b", "row", 0.5);
  const bottom = split("bottom", "c", "d", "row", 0.5);
  const nodes = { root, left, top, bottom, right: leaf("right", "s4", "%4"), a: leaf("a", "s0", "%0"), b: leaf("b", "s1", "%1"), c: leaf("c", "s2", "%2"), d: leaf("d", "s3", "%3") };
  const tree: TmuxLayoutNode = {
    kind: "row", w: 120, h: 40, children: [
      { kind: "column", w: 70, h: 40, children: [
        { kind: "row", w: 70, h: 20, children: [pane("s0", 35, 20), pane("s1", 34, 20)] },
        { kind: "row", w: 70, h: 19, children: [pane("s2", 35, 19), pane("s3", 34, 19)] },
      ] },
      pane("s4", 49, 40),
    ],
  };
  expect(tmuxResizeForSplit(root, nodes, tree, 0.6)).toEqual({
    sessionId: "s4", request: { request: "resize-pane", pane: "%4", axis: "width", cells: 48 },
  });
});

test("an axis hidden behind same-axis splits on both sides is unreachable by one pane command", () => {
  const root = split("root", "left", "right", "row", 0.6);
  const left = split("left", "topLeft", "bottomLeft", "column", 0.5);
  const right = split("right", "topRight", "bottomRight", "column", 0.5);
  const topLeft = split("topLeft", "a", "b", "row", 0.5);
  const bottomLeft = split("bottomLeft", "c", "d", "row", 0.5);
  const topRight = split("topRight", "e", "f", "row", 0.5);
  const bottomRight = split("bottomRight", "g", "h", "row", 0.5);
  const nodes = { root, left, right, topLeft, bottomLeft, topRight, bottomRight,
    a: leaf("a", "s0", "%0"), b: leaf("b", "s1", "%1"), c: leaf("c", "s2", "%2"), d: leaf("d", "s3", "%3"),
    e: leaf("e", "s4", "%4"), f: leaf("f", "s5", "%5"), g: leaf("g", "s6", "%6"), h: leaf("h", "s7", "%7"),
  };
  const row = (a: string, b: string, w: number, h: number): TmuxLayoutNode => ({ kind: "row", w, h, children: [pane(a, Math.ceil((w - 1) / 2), h), pane(b, Math.floor((w - 1) / 2), h)] });
  const tree: TmuxLayoutNode = { kind: "row", w: 120, h: 40, children: [
    { kind: "column", w: 70, h: 40, children: [row("s0", "s1", 70, 20), row("s2", "s3", 70, 19)] },
    { kind: "column", w: 49, h: 40, children: [row("s4", "s5", 49, 20), row("s6", "s7", 49, 19)] },
  ] };
  expect(tmuxResizeForSplit(root, nodes, tree, 0.6)).toBeNull();
});
