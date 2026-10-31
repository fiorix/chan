/// Turn a tmux window's layout into the serialized pane tree the layout
/// reconciler applies. A tmux pane is a leaf holding one terminal tab bound to
/// the pane's session (an empty leaf while the registry has not made one), and
/// an n-ary row or column folds into nested binary splits whose ratio gives
/// the first child its share of the remaining length along the axis, so the
/// dividers land where tmux's borders are.

import type { SerNode } from "./tabs.svelte";
import type { TmuxLayoutNode } from "./tmux";

export function tmuxLayoutToSer(node: TmuxLayoutNode): SerNode {
  if (node.kind === "pane") {
    return { k: "l", t: node.session ? [{ k: "t", tsid: node.session }] : [] };
  }
  const children = node.children.filter((child) => child.w > 0 && child.h > 0);
  if (children.length === 0) return { k: "l", t: [] };
  if (children.length === 1) return tmuxLayoutToSer(children[0]!);
  const length = (child: TmuxLayoutNode) => (node.kind === "row" ? child.w : child.h);
  const fold = (rest: TmuxLayoutNode[]): SerNode => {
    if (rest.length === 1) return tmuxLayoutToSer(rest[0]!);
    const [first, ...others] = rest;
    const total = rest.reduce((sum, child) => sum + length(child), 0);
    const ratio = total > 0 ? length(first!) / total : 0.5;
    return {
      k: "s",
      d: node.kind === "row" ? "r" : "c",
      a: tmuxLayoutToSer(first!),
      b: fold(others),
      r: Math.min(0.95, Math.max(0.05, ratio)),
    };
  };
  return fold(children);
}

/// Whether `value` has the shape of a layout node the connection sends.
export function isTmuxLayoutNode(value: unknown): value is TmuxLayoutNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (typeof node.w !== "number" || typeof node.h !== "number") return false;
  if (node.kind === "pane") return node.session === null || typeof node.session === "string";
  if (node.kind === "row" || node.kind === "column") {
    return Array.isArray(node.children) && node.children.every(isTmuxLayoutNode);
  }
  return false;
}
