// Per-tab popover ("..." bubble) state. Lives outside the FileTab
// schema because it is purely transient UI: no need to persist or to
// survive serialization. Anchored to the trigger button's bounding
// rect so the bubble can position itself in a portal-like layer.

export type AnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

// Which gesture opened the bubble. The tab-strip click opens the
// "tab" menu (rename / view config / lifecycle); a right-click in the
// editor or terminal BODY opens the "body" menu (selection-aware
// Cut/Copy/Paste + contextual actions); a click on a link a terminal
// underlines opens the "link" menu (open and copy its target). One
// bubble, three item sets; the widget branches on this. Defaults to
// "tab" so any unconverted caller keeps the full menu.
export type TabMenuSource = "tab" | "body" | "link";

export const tabMenu = $state<{
  openForTabId: string | null;
  anchor: AnchorRect | null;
  source: TabMenuSource;
}>({ openForTabId: null, anchor: null, source: "tab" });

export function openTabMenu(
  tabId: string,
  anchor: AnchorRect,
  source: TabMenuSource = "tab",
): void {
  tabMenu.openForTabId = tabId;
  tabMenu.anchor = anchor;
  tabMenu.source = source;
}

export function closeTabMenu(): void {
  tabMenu.openForTabId = null;
  tabMenu.anchor = null;
  tabMenu.source = "tab";
}

export function toggleTabMenu(
  tabId: string,
  anchor: AnchorRect,
  source: TabMenuSource = "tab",
): void {
  if (tabMenu.openForTabId === tabId) closeTabMenu();
  else openTabMenu(tabId, anchor, source);
}
