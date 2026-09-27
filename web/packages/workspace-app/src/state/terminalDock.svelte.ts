// Terminals are drawn once, above the pane tree, keyed by tab id
// (`components/Terminals.svelte`), and each terminal's element is docked into
// the terminal layer of the pane that holds it (`components/Pane.svelte`). A
// split rebuilds a pane's layer and a tab move names another pane; either way
// the element moves with its renderer, its socket and its screen. Rebuilding
// the terminal instead would dial its session for the whole retained history
// and replay bytes written at the old width into the new one.

import { untrack } from "svelte";
import type { Attachment } from "svelte/attachments";

import {
  allPaneTabs,
  paneActiveTabId,
  paneSide,
  paneTabs,
  type LayoutState,
  type PaneSide,
  type TerminalTab,
} from "./tabs.svelte";

/// Where a terminal tab is drawn, as the pane that holds it shows it.
export type TerminalPlacement = {
  tab: TerminalTab;
  paneId: string;
  side: PaneSide;
  active: boolean;
  focused: boolean;
};

/// Every terminal tab the layout draws, in pane-tree order, placed as its pane
/// shows it: active when it is the active tab of the pane's visible side and
/// Hybrid Nav is off, focused when that pane is the active one too. An id is
/// drawn once; a copy of it in another pane stays in the layout, undrawn, and
/// the console says so.
export function terminalPlacements(view: LayoutState, navigating: boolean): TerminalPlacement[] {
  const placements: TerminalPlacement[] = [];
  const drawnIn = new Map<string, string>();
  const walk = (nodeId: string): void => {
    const node = view.nodes[nodeId];
    if (!node) return;
    if (node.kind === "split") {
      walk(node.a);
      walk(node.b);
      return;
    }
    const visibleSide = paneSide(node);
    const visibleIds = new Set(paneTabs(node, visibleSide).map((tab) => tab.id));
    const activeId = paneActiveTabId(node, visibleSide);
    const sideBIds = new Set(paneTabs(node, "b").map((tab) => tab.id));
    for (const tab of allPaneTabs(node)) {
      if (tab.kind !== "terminal") continue;
      const drawnPane = drawnIn.get(tab.id);
      if (drawnPane !== undefined) {
        if (drawnPane !== node.id) {
          console.warn(
            `[chan] panes ${drawnPane} and ${node.id} both list tab ${tab.id}; drawing the first copy`,
          );
        }
        continue;
      }
      drawnIn.set(tab.id, node.id);
      const active = !navigating && tab.id === activeId && visibleIds.has(tab.id);
      placements.push({
        tab,
        paneId: node.id,
        side: sideBIds.has(tab.id) ? "b" : "a",
        active,
        focused: active && view.activePaneId === node.id,
      });
    }
  };
  walk(view.rootId);
  return placements;
}

/// Each pane's terminal layer, by pane id.
const layers = $state<Record<string, HTMLElement>>({});
/// The terminals docked at least once, by tab id.
const docked = $state<Record<string, true>>({});
/// How many times each docked terminal has moved to another layer.
const relocations = $state<Record<string, number>>({});

/// Attach to a pane's terminal layer, the element its terminals are docked
/// into. A pane rebuilt under the same id registers its new layer, and the
/// terminals it holds follow.
export function terminalLayer(paneId: string): Attachment<HTMLElement> {
  return (node) => {
    layers[paneId] = node;
    return () => {
      if (layers[paneId] === node) delete layers[paneId];
    };
  };
}

/// Attach to the element that carries one terminal, and keep it docked in the
/// layer of the pane `paneId` names. While that pane has no layer the element
/// stays where it is. A split, a move or a collapse rebuilds the layers within
/// one update, so no layout runs before the element is docked again. A pane
/// whose body failed to render has no layer until its boundary retries: its
/// terminals stay mounted in the detached layer they were in, until a retry
/// docks them again or their tabs close.
export function dockTerminal(tabId: string, paneId: () => string | undefined): Attachment<HTMLElement> {
  return (node) => {
    $effect(() => {
      const id = paneId();
      const layer = id === undefined ? undefined : layers[id];
      if (!layer || node.parentElement === layer) return;
      layer.append(node);
      untrack(() => {
        if (!docked[tabId]) docked[tabId] = true;
        else relocations[tabId] = (relocations[tabId] ?? 0) + 1;
      });
    });
    return () => {
      node.remove();
      delete docked[tabId];
      delete relocations[tabId];
    };
  };
}

/// Whether the terminal has been docked into a pane. A terminal mounts only
/// once it has, so its first fit measures the pane it is drawn in.
export function terminalDocked(tabId: string): boolean {
  return docked[tabId] === true;
}

/// How many times the terminal has moved to another layer since it was first
/// docked.
export function terminalRelocations(tabId: string): number {
  return relocations[tabId] ?? 0;
}
