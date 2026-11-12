// The settings index: one entry per field of the Settings overlay, as data.
// The overlay's sections render their fields from the same labels and option
// words, and the command launcher lists the entries in its Settings scope, so
// a setting reads the same in both places. A toggle or a choice can be changed
// from the launcher in place; any other field opens the overlay on it.
//
// An entry reads and writes without the overlay: the machine preferences
// through the record this window was served, and every other value through
// the state module that owns it.

import { privacy, setPrivacy } from "@chan/web-shared/privacy";
import { isTauriDesktop } from "../../api/desktop";
import type {
  BubbleOverlayMode,
  EditorTheme,
  HybridSurfaceKind,
  LineSpacing,
  Preferences,
  SearchAggression,
  TerminalContrast,
  TerminalFontChoice,
  ThemeChoice,
} from "../../api/types";
import { DATE_FORMATS } from "../../editor/dateFormats";
import { browserKeys, setBrowserVim } from "../../state/browserKeys.svelte";
import {
  applyEditorToolPreferences,
  persistStripTrailingWhitespaceOnSave,
} from "../../state/editorTools.svelte";
import { GRAPH_COLOR_ROWS, GRAPH_PALETTE_DEFAULTS } from "../../state/graphPalette.svelte";
import type { ScreensaverTheme } from "../../state/screensaver";
import { screensaver } from "../../state/screensaver.svelte";
import {
  clearHybridSurfaceTheme,
  currentPreferences,
  indexStatus,
  setHybridSurfaceTheme,
  setThemeChoice,
  ui,
  withHybridSurfaceTheme,
  workspace,
} from "../../state/store.svelte";
import { windowModeSecretMaskingEnabled } from "../../state/windowMode";
import { setWindowTabBarPreference, windowTabBar } from "../../state/windowTabBar.svelte";
import {
  TERMINAL_BACKGROUND_OPACITY_MAX,
  clampBackgroundOpacity,
} from "../../terminal/backgroundOpacity";
import { desktopTerminalOpacity } from "../../terminal/desktopTerminalOpacity.svelte";
import { clampScrollbackMb } from "../../terminal/scrollback";
import { customGraphColorsChange } from "./graphColors";
import {
  shownPreferences,
  writePreferences,
  type PreferencesChange,
} from "./preferenceState.svelte";
import type { SettingsSectionId } from "./sections";
import { customTerminalColorsChange, customTerminalColorsUpdate } from "./terminalColors";
import {
  patchScreenLock,
  refreshWorkspaceStateIfStale,
  reports,
  semantic,
  semanticCompiledIn,
  semanticModelLabel,
  setReportsEnabled,
  setSemanticEnabled,
  setSemanticModel,
} from "./workspace/workspaceState.svelte";

/// How the launcher treats a field: a toggle flips, a choice offers its
/// options, and an `open` field (a slider, text, a colour, a list, a button
/// flow) is edited in the overlay.
export type SettingKind = "toggle" | "choice" | "open";

export type SettingOption = {
  value: string;
  /// The option's word, verbatim as the overlay's control shows it.
  label: string;
};

export type SettingSpec = {
  /// Stable id, `<section>.<field>`. Also the anchor `openSettings` lands on.
  id: string;
  section: SettingsSectionId;
  /// The field's label, verbatim as the overlay renders it. A control inside
  /// a field with several reads `Field: control`.
  label: string;
  kind: SettingKind;
  /// A choice's options, in the overlay's order.
  options?: readonly SettingOption[];
  /// The current value: a boolean for a toggle, an option value for a choice,
  /// a display string for an `open` field, null while it has not loaded.
  read: () => boolean | string | null;
  /// Apply a value. Present on a toggle and a choice.
  write?: (value: boolean | string) => void | Promise<void>;
  /// Whether this window shows the field, by the overlay's own gates.
  available: () => boolean;
  /// The catalog command that changes the same setting, when one exists. The
  /// launcher then lists the command among typed results and keeps the
  /// setting to its Settings scope, so one change does not show twice.
  command?: string;
  /// Extra terms the launcher's search matches beyond the label.
  keywords?: readonly string[];
};

type Value = boolean | string;

/// How a field stored in the machine preferences reads and changes a
/// preferences record. The overlay applies it to its edit buffer, the index
/// to the record this window was served.
export type PreferenceAccess = {
  get(preferences: Preferences): Value;
  /// The change that stores `value`. Built once per write; the change itself
  /// runs again when the write is replayed over a newer record.
  change(value: Value): PreferencesChange;
  /// A setter of the field's own that persists `value` in place of the
  /// generic patch.
  persist?(value: Value): Promise<unknown>;
};

/// An index entry with the words the overlay renders it from. The label is
/// the heading of the field that holds the control. Where the heading alone
/// does not say what the control changes (one of several controls, or a
/// pill whose caption carries the meaning), the label reads
/// `Heading: caption`.
export type SettingEntry = SettingSpec & {
  heading: string;
  /// The control's own word in the overlay: a pill's caption, a row's label.
  /// The heading again for a control with no word of its own.
  caption: string;
  pref?: PreferenceAccess;
};

type Words = {
  id: string;
  section: SettingsSectionId;
  heading: string;
  caption?: string;
  /// Read the label as `Heading: caption`.
  qualified?: boolean;
  keywords?: readonly string[];
  command?: string;
  available?: () => boolean;
};

const always = (): boolean => true;
const inWorkspace = (): boolean => workspace.info !== null;

function entryWords(words: Words) {
  const caption = words.caption ?? words.heading;
  const qualified = words.qualified === true;
  // A caption the label leaves out is still a word the field is known by.
  const keywords = [
    ...(words.keywords ?? []),
    ...(caption !== words.heading && !qualified ? [caption] : []),
  ];
  return {
    id: words.id,
    section: words.section,
    label: qualified ? `${words.heading}: ${caption}` : words.heading,
    heading: words.heading,
    caption,
    available: words.available ?? always,
    ...(words.command !== undefined ? { command: words.command } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

function preferenceRead(access: PreferenceAccess): () => Value | null {
  return () => {
    const shown = shownPreferences();
    return shown ? access.get(shown) : null;
  };
}

function preferenceWrite(access: PreferenceAccess): (value: Value) => Promise<void> {
  return (value) => {
    const persist = access.persist;
    return writePreferences(access.change(value), persist ? () => persist(value) : undefined);
  };
}

/// A toggle stored in the machine preferences.
function toggle(
  words: Words,
  access: {
    get(preferences: Preferences): boolean;
    change(on: boolean): PreferencesChange;
    persist?(on: boolean): Promise<unknown>;
  },
): SettingEntry {
  const persist = access.persist;
  const pref: PreferenceAccess = {
    get: access.get,
    change: (value) => access.change(value === true),
    ...(persist ? { persist: (value: Value) => persist(value === true) } : {}),
  };
  return {
    ...entryWords(words),
    kind: "toggle",
    pref,
    read: preferenceRead(pref),
    write: preferenceWrite(pref),
  };
}

/// A fixed-option choice stored in the machine preferences.
function choice(
  words: Words,
  options: readonly SettingOption[],
  access: {
    get(preferences: Preferences): string;
    change(value: string): PreferencesChange;
    persist?(value: string): Promise<unknown>;
  },
): SettingEntry {
  const persist = access.persist;
  const pref: PreferenceAccess = {
    get: access.get,
    change: (value) => access.change(String(value)),
    ...(persist ? { persist: (value: Value) => persist(String(value)) } : {}),
  };
  return {
    ...entryWords(words),
    kind: "choice",
    options,
    pref,
    read: preferenceRead(pref),
    write: preferenceWrite(pref),
  };
}

/// A field edited only in the overlay, whose value is stored in the machine
/// preferences and shown as `display`.
function editedInOverlay(
  words: Words,
  display: (preferences: Preferences) => string,
): SettingEntry {
  return {
    ...entryWords(words),
    kind: "open",
    read: () => {
      const shown = shownPreferences();
      return shown ? display(shown) : null;
    },
  };
}

/// A toggle whose value lives outside the machine preferences.
function heldToggle(
  words: Words,
  read: () => boolean | null,
  write: (on: boolean) => void | Promise<void>,
): SettingEntry {
  return {
    ...entryWords(words),
    kind: "toggle",
    read,
    write: (value) => write(value === true),
  };
}

const THEMES: readonly SettingOption[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const BUBBLES: readonly SettingOption[] = [
  { value: "stack", label: "Inline" },
  { value: "tray", label: "Tray" },
];
const EDITOR_THEMES: readonly SettingOption[] = [
  { value: "github", label: "GitHub" },
  { value: "google_docs", label: "Google Docs" },
  { value: "word", label: "Microsoft Word" },
];
const SPACING: readonly SettingOption[] = [
  { value: "standard", label: "Standard" },
  { value: "compact", label: "Compact" },
];
const TERMINAL_ENGINES: readonly SettingOption[] = [
  { value: "ghostty", label: "ghostty" },
  { value: "xterm", label: "xterm" },
];
const TERMINAL_FONTS: readonly SettingOption[] = [
  { value: "os-default", label: "OS default (mono)" },
  { value: "source-code-pro", label: "Source Code Pro" },
];
const TERMINAL_CONTRAST: readonly SettingOption[] = [
  { value: "auto", label: "Auto" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];
const BODY_THEMES: readonly SettingOption[] = [
  { value: "inherit", label: "Inherit" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const AGGRESSION: readonly SettingOption[] = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" },
];
const LOCK_THEMES: readonly SettingOption[] = [
  { value: "plain", label: "Default" },
  { value: "matrix", label: "Matrix" },
];

/// The three colours of the custom terminal palette, in the overlay's order.
export const TERMINAL_COLOR_FIELDS = ["background", "foreground", "cursor"] as const;
export type TerminalColorField = (typeof TERMINAL_COLOR_FIELDS)[number];
const TERMINAL_COLOR_CAPTIONS: Record<TerminalColorField, string> = {
  background: "Background",
  foreground: "Foreground",
  cursor: "Cursor",
};

const BODY_THEME_HEADINGS: Record<HybridSurfaceKind, string> = {
  editor: "Editor body theme",
  terminal: "Terminal body theme",
  browser: "File browser body theme",
  graph: "Graph body theme",
  dashboard: "Dashboard body theme",
};

/// The body-theme override of one surface, filed under the surface's own
/// section. Inherit drops the key so the surface follows the app theme.
function bodyTheme(kind: HybridSurfaceKind): SettingEntry {
  return choice(
    { id: `${kind}.bodyTheme`, section: kind, heading: BODY_THEME_HEADINGS[kind] },
    BODY_THEMES,
    {
      get: (p) => p.hybrid_surface_themes?.[kind] ?? "inherit",
      change: (value) => (p) => ({
        ...p,
        hybrid_surface_themes: withHybridSurfaceTheme(p.hybrid_surface_themes, kind, value),
      }),
      // The store setters apply the skin live and persist through the same
      // serial config chain.
      persist: (value) =>
        value === "light" || value === "dark"
          ? setHybridSurfaceTheme(kind, value)
          : clearHybridSurfaceTheme(kind),
    },
  );
}

/// The editor page width as the slider shows it, in percent.
export function pageWidthPercent(ratio: number | undefined): number {
  const clamped = Math.min(1, Math.max(0.25, ratio ?? 0.8));
  return Math.round(clamped * 100);
}

/// The terminal background opacity as the slider words it.
export function backgroundOpacityLabel(percent: number): string {
  return percent >= TERMINAL_BACKGROUND_OPACITY_MAX ? "100% (off)" : `${percent}%`;
}

function customTerminalColors(): Preferences["terminal_colors"] {
  return shownPreferences()?.terminal_colors;
}

const customTerminalColorsOn = (): boolean => {
  const colors = customTerminalColors();
  return colors?.mode === "custom" && colors.custom !== undefined;
};

const customGraphColorsOn = (): boolean => shownPreferences()?.graph_colors?.mode === "custom";

const screenLockOn = (): boolean =>
  inWorkspace() && screensaver.loaded && screensaver.enabled;

const screenLockPinCaption = (): string => (screensaver.pin_set ? "Change PIN" : "Set PIN");

/// The value of a "This workspace" entry, asking the server for it again
/// when the window's copy has aged out.
function workspaceRead<T>(read: () => T): () => T {
  return () => {
    refreshWorkspaceStateIfStale();
    return read();
  };
}

/// Run a write whose owner answers a refusal instead of rejecting, and
/// reject with it.
async function refusing(run: Promise<string | null>): Promise<void> {
  const refusal = await run;
  if (refusal) throw new Error(refusal);
}

/// Write the viewer's privacy policy, whose owner reports a failed save as
/// state.
async function writePrivacy(patch: Parameters<typeof setPrivacy>[0]): Promise<void> {
  await setPrivacy(patch);
  if (privacy.error) throw new Error(privacy.error);
}

const ENTRIES: readonly SettingEntry[] = [
  // ---- Global ---------------------------------------------------------------
  heldToggle(
    {
      id: "global.privacy",
      section: "global",
      heading: "Privacy mode",
      caption: "Privacy mode on",
      keywords: ["screen sharing", "recording", "conceal", "hide"],
    },
    () => privacy.enabled,
    (enabled) => writePrivacy({ enabled }),
  ),
  heldToggle(
    {
      id: "global.privacyTerminalMasking",
      section: "global",
      heading: "Privacy mode",
      caption: "Also enable terminal secret masking",
      qualified: true,
    },
    () => privacy.mask_terminal_secrets,
    (mask_terminal_secrets) => writePrivacy({ mask_terminal_secrets }),
  ),
  choice(
    {
      id: "global.theme",
      section: "global",
      heading: "Theme",
      keywords: ["app theme", "appearance", "colour", "color"],
    },
    THEMES,
    {
      get: (p) => p.theme,
      change: (value) => (p) => ({ ...p, theme: value as ThemeChoice }),
      // The store setter re-skins the chrome the instant it is picked.
      persist: (value) => setThemeChoice(value as ThemeChoice),
    },
  ),
  choice(
    {
      id: "global.watcherBubbles",
      section: "global",
      heading: "Watcher bubbles",
      keywords: ["filesystem", "notices"],
    },
    BUBBLES,
    {
      get: (p) => p.bubble_overlay_mode,
      change: (value) => (p) => ({ ...p, bubble_overlay_mode: value as BubbleOverlayMode }),
    },
  ),
  toggle(
    {
      id: "global.dashboardCarousel",
      section: "global",
      heading: "Dashboard carousel",
      caption: "Auto-rotate",
      qualified: true,
      keywords: ["slides", "cycling"],
    },
    {
      get: (p) => p.empty_pane_carousel_cycling ?? true,
      change: (on) => (p) => ({ ...p, empty_pane_carousel_cycling: on }),
    },
  ),
  // chan-desktop's own setting, not a preference of the server this window
  // shows: the desktop stores it and every window switches when it hears.
  heldToggle(
    {
      id: "global.titlebarTabs",
      section: "global",
      heading: "Title bar tabs",
      caption: "In the title bar",
      available: () => windowTabBar.available,
    },
    () => windowTabBar.preferred,
    (on) => setWindowTabBarPreference(on),
  ),
  // The tabs in the title bar take no room from a pane, so auto-hide applies
  // only while they stay in the panes.
  toggle(
    {
      id: "global.paneStrip",
      section: "global",
      heading: "Pane strip",
      caption: "Auto-hide",
      qualified: true,
      keywords: ["tab strip"],
      available: () => !windowTabBar.on,
    },
    {
      get: (p) => p.pane_strip_auto_hide ?? false,
      change: (on) => (p) => ({ ...p, pane_strip_auto_hide: on }),
    },
  ),

  // ---- Editor ---------------------------------------------------------------
  choice(
    {
      id: "editor.theme",
      section: "editor",
      heading: "Editor theme",
      keywords: ["typography", "markdown"],
    },
    EDITOR_THEMES,
    {
      get: (p) => p.editor_theme,
      change: (value) => (p) => ({ ...p, editor_theme: value as EditorTheme }),
    },
  ),
  choice(
    {
      id: "editor.lineSpacing",
      section: "editor",
      heading: "Line spacing",
      keywords: ["density"],
    },
    SPACING,
    {
      // A stored "tight" is the retired spelling of compact.
      get: (p) =>
        (p.line_spacing as string) === "tight" || p.line_spacing === "compact"
          ? "compact"
          : "standard",
      change: (value) => (p) => ({ ...p, line_spacing: value as LineSpacing }),
    },
  ),
  editedInOverlay(
    { id: "editor.fontSize", section: "editor", heading: "Editor font size" },
    (p) => (p.editor_font_size == null ? "Theme" : `${p.editor_font_size} px`),
  ),
  choice(
    { id: "editor.dateFormat", section: "editor", heading: "Date format" },
    DATE_FORMATS.map((format) => ({ value: format.id, label: format.label })),
    {
      // A retired format id shows as the first format, as the overlay does.
      get: (p) =>
        DATE_FORMATS.some((format) => format.id === p.date_format)
          ? p.date_format
          : DATE_FORMATS[0]!.id,
      change: (value) => (p) => ({ ...p, date_format: value }),
    },
  ),
  toggle(
    {
      id: "editor.stripTrailingWhitespace",
      section: "editor",
      heading: "Strip trailing whitespace",
      caption: "Strip on save",
    },
    {
      get: (p) => p.strip_trailing_whitespace_on_save,
      change: (on) => (p) => ({ ...p, strip_trailing_whitespace_on_save: on }),
      // The setter hands the choice to open editors before the round trip;
      // a refusal puts the served choice back.
      persist: (on) =>
        persistStripTrailingWhitespaceOnSave(on).catch((error: unknown) => {
          applyEditorToolPreferences(currentPreferences() ?? {});
          throw error;
        }),
    },
  ),
  editedInOverlay(
    { id: "editor.pageWidth", section: "editor", heading: "Editor page width" },
    (p) => `${pageWidthPercent(p.page_width_ratio)}%`,
  ),
  bodyTheme("editor"),

  // ---- Terminal -------------------------------------------------------------
  editedInOverlay(
    { id: "terminal.scrollback", section: "terminal", heading: "Scrollback" },
    (p) => `${clampScrollbackMb(p.terminal.scrollback_mb)} MB`,
  ),
  editedInOverlay(
    { id: "terminal.term", section: "terminal", heading: "TERM" },
    (p) => p.terminal.default_term || "xterm-256color",
  ),
  toggle(
    {
      id: "terminal.mcpEnv",
      section: "terminal",
      heading: "MCP discovery",
      caption: "Enable in new terminals",
      keywords: ["CHAN_MCP", "agent"],
    },
    {
      get: (p) => p.terminal.mcp_env ?? false,
      change: (on) => (p) => ({ ...p, terminal: { ...p.terminal, mcp_env: on } }),
    },
  ),
  toggle(
    {
      id: "terminal.mouseCapture",
      section: "terminal",
      heading: "Mouse capture",
      caption: "Allow in new terminals",
    },
    {
      get: (p) => p.terminal.mouse_capture ?? true,
      change: (on) => (p) => ({ ...p, terminal: { ...p.terminal, mouse_capture: on } }),
    },
  ),
  choice(
    {
      id: "terminal.engine",
      section: "terminal",
      heading: "Terminal engine (new terminals)",
      keywords: ["backend", "renderer", "Ghostty backend", "ghostty-web", "xterm.js"],
    },
    TERMINAL_ENGINES,
    {
      get: (p) => (p.terminal.ghostty ? "ghostty" : "xterm"),
      change: (value) => (p) => ({
        ...p,
        terminal: { ...p.terminal, ghostty: value === "ghostty" },
      }),
    },
  ),
  toggle(
    {
      id: "terminal.programStatus",
      section: "terminal",
      heading: "Program status",
      caption: "Program status (OSC 7501)",
    },
    {
      get: (p) => p.terminal.program_status ?? true,
      change: (on) => (p) => ({ ...p, terminal: { ...p.terminal, program_status: on } }),
    },
  ),
  toggle(
    {
      id: "terminal.tmux",
      section: "terminal",
      heading: "tmux control mode",
      caption: "tmux control mode (tmux -CC)",
    },
    {
      get: (p) => p.terminal.tmux?.enabled ?? false,
      change: (on) => (p) => ({
        ...p,
        terminal: { ...p.terminal, tmux: { ...(p.terminal.tmux ?? {}), enabled: on } },
      }),
    },
  ),
  toggle(
    {
      id: "terminal.secretMasking",
      section: "terminal",
      heading: "Secret masking",
      caption: "Mask secrets in new terminals",
    },
    {
      // What a new terminal of this window starts with: the stored choice,
      // or with none stored the window's default.
      get: (p) =>
        windowModeSecretMaskingEnabled(p.terminal.secret_masking ?? null, {
          terminalControl: ui.terminalControl,
        }),
      change: (on) => (p) => ({ ...p, terminal: { ...p.terminal, secret_masking: on } }),
    },
  ),
  choice(
    { id: "terminal.font", section: "terminal", heading: "Terminal font" },
    TERMINAL_FONTS,
    {
      get: (p) => p.terminal.font ?? "os-default",
      change: (value) => (p) => ({
        ...p,
        terminal: { ...p.terminal, font: value as TerminalFontChoice },
      }),
    },
  ),
  editedInOverlay(
    { id: "terminal.fontSize", section: "terminal", heading: "Terminal font size" },
    (p) => `${p.terminal.font_size ?? 14} px`,
  ),
  editedInOverlay(
    {
      id: "terminal.backgroundOpacity",
      section: "terminal",
      heading: "Background opacity",
      keywords: ["transparent", "see-through"],
    },
    // In a desktop window the value is chan-desktop's own.
    (p) =>
      backgroundOpacityLabel(
        isTauriDesktop()
          ? (desktopTerminalOpacity() ?? TERMINAL_BACKGROUND_OPACITY_MAX)
          : clampBackgroundOpacity(p.terminal.background_opacity),
      ),
  ),
  toggle(
    {
      id: "terminal.customColors",
      section: "terminal",
      heading: "Custom terminal colours",
      caption: "Custom terminal colours",
      keywords: ["colors", "palette"],
    },
    {
      get: (p) => p.terminal_colors?.mode === "custom",
      change: customTerminalColorsChange,
    },
  ),
  choice(
    {
      id: "terminal.ansiContrast",
      section: "terminal",
      heading: "ANSI contrast",
      available: customTerminalColorsOn,
    },
    TERMINAL_CONTRAST,
    {
      get: (p) => p.terminal_colors?.custom?.contrast ?? "auto",
      change: (value) =>
        customTerminalColorsUpdate((custom) => ({
          ...custom,
          contrast: value as TerminalContrast,
        })),
    },
  ),
  ...TERMINAL_COLOR_FIELDS.map((field) =>
    editedInOverlay(
      {
        id: `terminal.colors.${field}`,
        section: "terminal",
        heading: "Custom terminal colours",
        caption: TERMINAL_COLOR_CAPTIONS[field],
        qualified: true,
        available: customTerminalColorsOn,
      },
      (p) => p.terminal_colors?.custom?.[field] ?? "",
    ),
  ),
  bodyTheme("terminal"),

  // ---- File browser ---------------------------------------------------------
  ...(["left", "right"] as const).map((side) =>
    toggle(
      {
        id: `browser.${side}Dock`,
        section: "browser",
        heading: side === "left" ? "Left file browser dock" : "Right file browser dock",
        caption: "Show",
        keywords: ["side pane", "Side panes", `${side === "left" ? "Left" : "Right"} pane`, "stick"],
        command: side === "left" ? "app.browser.toggleLeftDock" : "app.browser.toggleRightDock",
      },
      {
        get: (p) => p.browser_side_panes[side],
        change: (on) => (p) => ({
          ...p,
          browser_side_panes: { ...p.browser_side_panes, [side]: on },
        }),
      },
    ),
  ),
  heldToggle(
    {
      id: "browser.vim",
      section: "browser",
      heading: "Keyboard navigation",
      caption: "Vim navigation",
      qualified: true,
    },
    () => browserKeys.vim,
    setBrowserVim,
  ),
  bodyTheme("browser"),

  // ---- Graph ----------------------------------------------------------------
  toggle(
    {
      id: "graph.customColors",
      section: "graph",
      heading: "Custom graph colours",
      caption: "Custom graph colours",
      keywords: ["colors", "palette", "node hues"],
    },
    {
      get: (p) => p.graph_colors?.mode === "custom",
      change: customGraphColorsChange,
    },
  ),
  ...GRAPH_COLOR_ROWS.map((row) =>
    editedInOverlay(
      {
        id: `graph.colors.${row.kind}`,
        section: "graph",
        heading: "Custom graph colours",
        caption: row.label,
        qualified: true,
        available: customGraphColorsOn,
      },
      // The hue of the scheme the window wears, which is the palette the
      // overlay opens on.
      (p) => p.graph_colors?.[ui.theme]?.[row.kind] ?? GRAPH_PALETTE_DEFAULTS[ui.theme][row.kind],
    ),
  ),
  bodyTheme("graph"),

  // ---- Dashboard ------------------------------------------------------------
  bodyTheme("dashboard"),

  // ---- Search ---------------------------------------------------------------
  choice(
    {
      id: "search.indexing",
      section: "search",
      heading: "Search indexing",
      keywords: ["indexer", "resource profile", "aggression"],
    },
    AGGRESSION,
    {
      get: (p) => p.search_aggression,
      change: (value) => (p) => ({ ...p, search_aggression: value as SearchAggression }),
    },
  ),

  // ---- Keyboard Shortcuts ---------------------------------------------------
  // A grid of commands and their chords, not fields: one entry opens it.
  {
    ...entryWords({
      id: "shortcuts.grid",
      section: "shortcuts",
      heading: "Keyboard Shortcuts",
      keywords: ["keymap", "chords", "bindings", "hotkeys"],
    }),
    kind: "open",
    read: () => "",
  },

  // ---- This workspace -------------------------------------------------------
  {
    ...entryWords({
      id: "workspace.index",
      section: "workspace",
      heading: "Index",
      keywords: ["search index", "rebuild"],
      available: inWorkspace,
    }),
    kind: "open",
    read: () => indexStatus.value?.state ?? null,
  },
  heldToggle(
    {
      id: "workspace.semantic",
      section: "workspace",
      heading: "Semantic search",
      caption: "Enable semantic search (Hybrid mode)",
      keywords: ["embedding", "vector"],
      available: () => inWorkspace() && semanticCompiledIn(),
    },
    workspaceRead(() => semantic.state?.semantic_enabled ?? null),
    (on) => refusing(setSemanticEnabled(on)),
  ),
  {
    ...entryWords({
      id: "workspace.embeddingModel",
      section: "workspace",
      heading: "Embedding model",
      caption: "Model",
      keywords: ["semantic", "vector", "bge"],
      available: () => inWorkspace() && semanticCompiledIn(),
    }),
    kind: "choice",
    // The server's registry, so the list is empty until it has been read.
    get options(): readonly SettingOption[] {
      return (semantic.models?.models ?? []).map((model) => ({
        value: model.id,
        label: semanticModelLabel(model),
      }));
    },
    read: workspaceRead(() => semantic.models?.current_model ?? null),
    write: (value) => refusing(setSemanticModel(String(value))),
  },
  {
    ...entryWords({
      id: "workspace.excludedDirs",
      section: "workspace",
      heading: "Excluded directories",
      keywords: ["blocklist", "skip", "ignore"],
      available: inWorkspace,
    }),
    kind: "open",
    read: () => "",
  },
  heldToggle(
    {
      id: "workspace.reports",
      section: "workspace",
      heading: "chan-reports",
      caption: "Enable chan-reports indexing",
      keywords: ["sloc", "language rollups"],
      available: inWorkspace,
    },
    workspaceRead(() => reports.state?.enabled ?? null),
    (on) => refusing(setReportsEnabled(on)),
  ),
  {
    ...entryWords({
      id: "workspace.metadata",
      section: "workspace",
      heading: "Metadata archive",
      keywords: ["export", "import", "restore", "backup"],
      available: inWorkspace,
    }),
    kind: "open",
    read: () => "",
  },
  // The running lock's state is the one the control shows, loaded when the
  // window boots and after every write.
  heldToggle(
    {
      id: "workspace.screenLock",
      section: "workspace",
      heading: "Screen lock",
      keywords: ["screensaver", "auto-lock"],
      available: inWorkspace,
    },
    () => (screensaver.loaded ? screensaver.enabled : null),
    (enabled) => patchScreenLock({ enabled }),
  ),
  {
    ...entryWords({
      id: "workspace.screenLock.timeout",
      section: "workspace",
      heading: "Screen lock",
      caption: "Inactivity timeout (seconds)",
      qualified: true,
      available: screenLockOn,
    }),
    kind: "open",
    read: () => String(screensaver.timeout_secs),
  },
  {
    // The button reads by whether a PIN is stored, and so does the entry.
    ...entryWords({
      id: "workspace.screenLock.pin",
      section: "workspace",
      heading: "Screen lock",
      keywords: ["PIN", "passcode", "password"],
      command: "app.screensaver.setPin",
      available: screenLockOn,
    }),
    get caption(): string {
      return screenLockPinCaption();
    },
    get label(): string {
      return `Screen lock: ${screenLockPinCaption()}`;
    },
    kind: "open",
    read: () => (screensaver.pin_set ? "set" : "not set"),
  },
  {
    ...entryWords({
      id: "workspace.screenLock.theme",
      section: "workspace",
      heading: "Screen lock",
      caption: "Theme",
      qualified: true,
      keywords: ["screensaver", "matrix"],
      available: screenLockOn,
    }),
    kind: "choice",
    options: LOCK_THEMES,
    read: () => screensaver.theme,
    write: (value) => patchScreenLock({ theme: value as ScreensaverTheme }),
  },
];

const BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry]));

/// Overlay fields the index leaves out, each with the reason. The coverage
/// test holds this to exactly the rendered fields without an entry.
export const UNINDEXED_FIELDS: Readonly<Record<string, string>> = {
  "Editing palette":
    "chooses which scheme's palette the colour rows edit; nothing is stored",
};

/// Every field the Settings overlay offers in this window, in rail and field
/// order.
export function settingsIndex(): readonly SettingSpec[] {
  return ENTRIES;
}

/// The entry a section renders a field from.
export function settingEntry(id: string): SettingEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`settings index has no entry ${id}`);
  return entry;
}

/// A choice's options, for the control that renders them.
export function optionsOf(entry: SettingEntry): readonly SettingOption[] {
  return entry.options ?? [];
}

/// A toggle's state in the preferences record the overlay is editing.
export function toggledIn(entry: SettingEntry, preferences: Preferences): boolean {
  return entry.pref?.get(preferences) === true;
}

/// A choice's value in the preferences record the overlay is editing.
export function chosenIn(entry: SettingEntry, preferences: Preferences): string {
  return String(entry.pref?.get(preferences) ?? "");
}
