// View state of a file browser surface that its own menu and the command
// catalog both change: whether hidden files are listed, whether rows are
// marked one at a time, and whether its key list is shown. A record is keyed
// by the surface's instance id (`fb-tab-<tab id>`, `fb-dock-<side>`), as the
// tree registry is, because a docked browser has no tab to hold it.
//
// A record lasts as long as what it belongs to. A tab's lasts while the tab
// is open, shown or not: a pane draws one surface for whichever of its tabs
// is active, so the surface goes with every tab switch, and the registry
// follows the layout instead, forgetting a tab's record once no layout
// holds the tab. A tab closed and reopened starts from the defaults. A
// dock's record is dropped by its surface, which is mounted for exactly as
// long as the dock is shown.
//
// A file browser tab's Details panel is a switch of the same kind, which the
// toolbar and the catalog both flip. It is kept on the tab, not in a record
// here, because a reload restores it with the tab.

import { untrack } from "svelte";
import { allPaneTabs, layout, paneMode, type BrowserTab, type LayoutState } from "./tabs.svelte";

export type BrowserView = {
  /// List the entries whose name starts with a dot.
  showHidden: boolean;
  /// A click or the cursor marks rows one at a time instead of selecting one.
  selectionMode: boolean;
  /// The surface's key list is shown.
  helpOpen: boolean;
};

const DEFAULTS: Readonly<BrowserView> = {
  showHidden: true,
  selectionMode: false,
  helpOpen: false,
};

const views = $state<{ byId: Record<string, BrowserView> }>({ byId: {} });

/// What a tab surface's instance id starts with, before the tab's id.
const TAB_INSTANCE = "fb-tab-";

function addBrowserTabIds(state: LayoutState, ids: Set<string>): void {
  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) if (tab.kind === "browser") ids.add(tab.id);
  }
}

let followingLayout = false;

/// Forget each tab's record once no layout holds its tab, at every change of
/// the layout. Hybrid Nav draws its draft, where a tab can be staged before
/// the layout has it, so a tab either one holds is open. A move puts a copy
/// of the tab back under the same id within one change, so its record stays.
/// The effect has no component to belong to: it starts with the first tab
/// record and runs for as long as the page does, since a tab can close while
/// no surface is drawn at all.
function followLayout(): void {
  if (followingLayout) return;
  followingLayout = true;
  $effect.root(() => {
    $effect(() => {
      const open = new Set<string>();
      addBrowserTabIds(layout, open);
      if (paneMode.active && paneMode.draft) addBrowserTabIds(paneMode.draft, open);
      untrack(() => {
        for (const id of Object.keys(views.byId)) {
          if (id.startsWith(TAB_INSTANCE) && !open.has(id.slice(TAB_INSTANCE.length))) delete views.byId[id];
        }
      });
    });
  });
}

/// The view state of the surface with `instanceId`; the defaults for a
/// surface that has changed nothing.
export function browserView(instanceId: string): Readonly<BrowserView> {
  return views.byId[instanceId] ?? DEFAULTS;
}

/// Change part of a surface's view state.
export function setBrowserView(instanceId: string, change: Partial<BrowserView>): void {
  views.byId[instanceId] = { ...browserView(instanceId), ...change };
  if (instanceId.startsWith(TAB_INSTANCE)) followLayout();
}

/// Flip one switch of a surface's view state. A menu row and its catalog
/// command both toggle through here.
export function toggleBrowserView(instanceId: string, key: keyof BrowserView): void {
  setBrowserView(instanceId, { [key]: !browserView(instanceId)[key] });
}

/// Forget a surface's view state.
export function dropBrowserView(instanceId: string): void {
  delete views.byId[instanceId];
}

/// Show or hide a file browser tab's Details panel. The toolbar button, the
/// key that previews the selection and the catalog command all flip it here.
export function toggleBrowserDetails(tab: Pick<BrowserTab, "inspectorOpen">): void {
  tab.inspectorOpen = !tab.inspectorOpen;
}
