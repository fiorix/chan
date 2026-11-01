import { allPaneTabs, type Node, type SplitNode, type TerminalTab } from "./tabs.svelte";
import type { TmuxLayoutNode, TmuxRequest } from "./tmux";

export type TmuxPaneResize = {
  sessionId: string;
  request: Extract<TmuxRequest, { request: "resize-pane" }>;
};

function liveSessions(id: string, nodes: Record<string, Node>): string[] {
  const node = nodes[id];
  if (!node) return [];
  if (node.kind === "split") return [...liveSessions(node.a, nodes), ...liveSessions(node.b, nodes)];
  return allPaneTabs(node).flatMap((tab) =>
    tab.kind === "terminal" && tab.tmuxPane && tab.terminalSessionId ? [tab.terminalSessionId] : [],
  );
}

function layoutSessions(node: TmuxLayoutNode): string[] {
  if (node.kind === "pane") return node.session ? [node.session] : [];
  return node.children.flatMap(layoutSessions);
}

function sameSessions(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((session) => b.includes(session));
}

// tmux's absolute pane resize walks to the target's nearest ancestor on the
// requested axis. A pane below another split on that axis would move a
// different border, so only a first-side pane with a direct axis path fits.
function firstPaneOnAxis(node: TmuxLayoutNode, axis: "row" | "column"): string | null {
  if (node.kind === "pane") return node.session;
  const children = node.children.filter((child) => child.w > 0 && child.h > 0);
  if (node.kind === axis && children.length > 1) return null;
  for (const child of children) {
    if (child.kind === "pane" && child.session) return child.session;
  }
  for (const child of children) {
    const session = firstPaneOnAxis(child, axis);
    if (session) return session;
  }
  return null;
}

function tabForSession(nodes: Record<string, Node>, session: string): TerminalTab | null {
  for (const node of Object.values(nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) {
      if (tab.kind === "terminal" && tab.tmuxPane && tab.terminalSessionId === session) return tab;
    }
  }
  return null;
}

/// Resolve the dragged split against tmux's last layout. tmux's child sizes
/// omit divider cells, as `tmuxLayoutToSer` does when it derives split ratios;
/// the requested pane size uses the same cell span. A layout reply owns the
/// ratio after the request, including a size tmux clamps at its boundary.
export function tmuxResizeForSplit(
  split: SplitNode,
  nodes: Record<string, Node>,
  tree: TmuxLayoutNode,
  ratio: number,
): TmuxPaneResize | null {
  if (!Number.isFinite(ratio)) return null;
  const first = liveSessions(split.a, nodes);
  const second = liveSessions(split.b, nodes);
  if (first.length === 0 || second.length === 0) return null;
  const axis = split.direction;
  const length = (node: TmuxLayoutNode) => (axis === "row" ? node.w : node.h);
  const find = (node: TmuxLayoutNode): TmuxPaneResize | null => {
    if (node.kind === "pane") return null;
    const children = node.children.filter((child) => child.w > 0 && child.h > 0);
    if (node.kind === axis) {
      for (let i = 0; i < children.length - 1; i++) {
        const child = children[i]!;
        const rest = children.slice(i + 1);
        if (!sameSessions(first, layoutSessions(child)) || !sameSessions(second, rest.flatMap(layoutSessions))) continue;
        const firstSession = firstPaneOnAxis(child, axis);
        const secondSession = i === children.length - 2 ? firstPaneOnAxis(rest[0]!, axis) : null;
        const session = firstSession ?? secondSession;
        const tab = session ? tabForSession(nodes, session) : null;
        if (!session || !tab?.tmuxPane) return null;
        const span = children.slice(i).reduce((sum, item) => sum + length(item), 0);
        const cells = Math.max(1, Math.round((firstSession ? ratio : 1 - ratio) * span));
        if (cells > 10_000) return null;
        return {
          sessionId: session,
          request: { request: "resize-pane", pane: tab.tmuxPane.pane, axis: axis === "row" ? "width" : "height", cells },
        };
      }
    }
    for (const child of children) {
      const request = find(child);
      if (request) return request;
    }
    return null;
  };
  return find(tree);
}
