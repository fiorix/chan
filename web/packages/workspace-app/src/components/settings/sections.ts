// The Settings rail, derived from the command registry's category set
// rather than typed out beside it: every category either has a section
// here or is excluded below with the reason recorded, so Settings and
// the launcher cannot disagree about which surface owns a setting.
// settingsRail.test.ts checks this list against the live registry, so
// the next surface that gets commands without a section goes red.

import type { CommandCategory } from "../../state/commands";
import {
  FolderCog,
  FolderOpen,
  Keyboard,
  LayoutDashboard,
  Palette,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Waypoints,
} from "lucide-svelte";

export type SettingsSectionDef = {
  id: string;
  label: string;
  /// The registry category the section answers to. Null for Keyboard
  /// Shortcuts: not a category, a meta section mounted through its own
  /// container.
  category: CommandCategory | null;
  icon: typeof Palette;
};

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: "global", label: "Global", category: "Global", icon: Palette },
  { id: "editor", label: "Editor", category: "Editor", icon: SlidersHorizontal },
  { id: "terminal", label: "Terminal", category: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "File browser", category: "File Browser", icon: FolderOpen },
  { id: "graph", label: "Graph", category: "Graph", icon: Waypoints },
  { id: "dashboard", label: "Dashboard", category: "Dashboard", icon: LayoutDashboard },
  { id: "search", label: "Search", category: "Search", icon: Search },
  { id: "shortcuts", label: "Keyboard Shortcuts", category: null, icon: Keyboard },
  { id: "workspace", label: "This workspace", category: "Workspace", icon: FolderCog },
];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/// Registry categories with no section, each named with the reason so
/// the question is not reopened. The rail test asserts this set stays
/// exactly the categories without a section.
export const EXCLUDED_CATEGORIES: Partial<Record<CommandCategory, string>> = {
  Apps: "persists no preference",
  Tabs: "persists no preference",
  Panes: "persists only pane_widths, which is drag-owned and stays unsurfaced",
};
