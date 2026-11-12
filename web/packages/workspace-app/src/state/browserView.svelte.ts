// View state of a file browser surface that its own menu and the command
// catalog both change: whether hidden files are listed, whether rows are
// marked one at a time, and whether its key list is shown. A record is keyed
// by the surface's instance id (`fb-tab-<tab id>`, `fb-dock-<side>`), as the
// tree registry is, because a docked browser has no tab to hold it. The
// surface drops its record when it unmounts, so a browser shown again starts
// from the defaults.
//
// A file browser tab's Details panel is a switch of the same kind, which the
// toolbar and the catalog both flip. It is kept on the tab, not in a record
// here, because a reload restores it with the tab.

import type { BrowserTab } from "./tabs.svelte";

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

/// The view state of the surface with `instanceId`; the defaults for a
/// surface that has changed nothing.
export function browserView(instanceId: string): Readonly<BrowserView> {
  return views.byId[instanceId] ?? DEFAULTS;
}

/// Change part of a surface's view state.
export function setBrowserView(instanceId: string, change: Partial<BrowserView>): void {
  views.byId[instanceId] = { ...browserView(instanceId), ...change };
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
