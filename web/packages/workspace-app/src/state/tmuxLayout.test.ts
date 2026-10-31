import { expect, test } from "vitest";
import { isTmuxLayoutNode, tmuxLayoutToSer } from "./tmuxLayout";

test("a pane is a leaf with one terminal tab bound to its session, or empty before the session lands", () => {
  expect(tmuxLayoutToSer({ kind: "pane", session: "s1", w: 80, h: 24 })).toEqual({ k: "l", t: [{ k: "t", tsid: "s1" }] });
  expect(tmuxLayoutToSer({ kind: "pane", session: null, w: 80, h: 24 })).toEqual({ k: "l", t: [] });
});

test("a row of three folds into nested splits whose ratios give each pane tmux's share", () => {
  const ser = tmuxLayoutToSer({
    kind: "row",
    w: 160,
    h: 24,
    children: [
      { kind: "pane", session: "a", w: 40, h: 24 },
      { kind: "pane", session: "b", w: 60, h: 24 },
      { kind: "pane", session: "c", w: 60, h: 24 },
    ],
  });
  expect(ser).toEqual({
    k: "s",
    d: "r",
    r: 0.25,
    a: { k: "l", t: [{ k: "t", tsid: "a" }] },
    b: {
      k: "s",
      d: "r",
      r: 0.5,
      a: { k: "l", t: [{ k: "t", tsid: "b" }] },
      b: { k: "l", t: [{ k: "t", tsid: "c" }] },
    },
  });
});

test("a column nests a row, a one-child node collapses, and sizes outside the slack are clamped", () => {
  const ser = tmuxLayoutToSer({
    kind: "column",
    w: 80,
    h: 100,
    children: [
      { kind: "pane", session: "top", w: 80, h: 2 },
      { kind: "row", w: 80, h: 98, children: [{ kind: "pane", session: "only", w: 80, h: 98 }] },
    ],
  });
  expect(ser).toEqual({
    k: "s",
    d: "c",
    r: 0.05,
    a: { k: "l", t: [{ k: "t", tsid: "top" }] },
    b: { k: "l", t: [{ k: "t", tsid: "only" }] },
  });
});

test("the shape guard accepts the connection's trees and refuses others", () => {
  expect(isTmuxLayoutNode({ kind: "pane", session: null, w: 1, h: 1 })).toBe(true);
  expect(isTmuxLayoutNode({ kind: "row", w: 2, h: 1, children: [{ kind: "pane", session: "x", w: 1, h: 1 }] })).toBe(true);
  expect(isTmuxLayoutNode({ kind: "row", w: 2, h: 1, children: [{ kind: "nope" }] })).toBe(false);
  expect(isTmuxLayoutNode({ kind: "pane", w: 1, h: 1 })).toBe(false);
  expect(isTmuxLayoutNode(null)).toBe(false);
});
