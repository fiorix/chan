// Central registry of every user-visible keyboard shortcut.
//
// One source of truth for:
//   1. App.svelte's `onWindowKey` (browser keymap).
//   2. chan-desktop's KEY_BRIDGE_JS (native keymap; rebroadcasts as
//      `chan:command` events that chan handles).
//   3. crates/chan/src/lib.rs KEYBINDINGS_TABLE (the chord table in
//      the `chan serve --help` text). Resync via `node
//      web/packages/workspace-app/scripts/shortcuts-table.mjs
//      --serve-long-about`.
//
// Chord grammar: a `+`-separated list of modifier tokens followed by
// a single key. Modifier tokens:
//   - `Mod`   → Cmd on macOS, Ctrl on Linux / Windows.
//   - `Cmd`   → literal Command / Meta (used for browser fallbacks
//               where Ctrl would collide with an existing chord).
//   - `Ctrl`  → literal Ctrl (used for the `Ctrl+Alt+...` web fallbacks
//               that mean the actual Control key on every platform).
//   - `Alt`   → Alt / Option.
//   - `Shift` → Shift.
// Keys are written as the user reads them (`P`, `[`, `Enter`, `1..9`).
//
// Per-platform variants: most shortcuts use the same chord across
// web and native, but some differ because the browser owns certain
// chords (Cmd+W, Cmd+N, Cmd+1..9, Cmd+F/G) and we have to fall back
// to Alt+Shift / Ctrl+Alt combos. Native (chan-desktop) intercepts
// the OS-reserved chords in a webview init script and replays the
// same `chan:command` event, so the in-app handler stays unified.

export type Chord = string;

/// The two surfaces chan ships. `web` is the in-browser fallback
/// chord set; `native` is the chord set chan-desktop's init script
/// binds (which layers VS Code-shaped chords on top of the web set).
export type Platform = "web" | "native";

/// OS only affects how `Mod` is rendered (Cmd vs Ctrl). The keymap
/// itself doesn't branch on OS - only the printable label does.
export type OS = "mac" | "linux" | "windows";

export type ShortcutGroup =
  | "App"
  | "File"
  | "Tabs"
  | "Panes"
  | "Find"
  | "Terminal"
  | "Editor";

export type Shortcut = {
  /// Stable command id. Matches `chan:command` event names so a
  /// caller can fire actions without going through the chord layer.
  id: string;
  /// Human-readable description for the table.
  label: string;
  /// Chord on the web fallback set. Omit when the action is not
  /// reachable via a chord in the browser (e.g. Cmd+S - browser
  /// shows the save-page dialog; chan can't preventDefault that on
  /// every browser reliably).
  web?: Chord;
  /// Chord chan-desktop's init script binds. ALWAYS set this, repeating
  /// the `web` chord when both surfaces share one: `osChord` returns
  /// undefined for a platform whose field is absent, so a `web`-only
  /// entry silently drops its row from the native help table and
  /// resolves to null in `chordFor` on the desktop. Omit only when the
  /// action genuinely has no native chord.
  native?: Chord;
  group: ShortcutGroup;
  /// Optional trailing parenthetical for the table (e.g. "browser
  /// owns this chord - handled natively").
  note?: string;
  /// When true, `handleTerminalKeyEvent` in `TerminalTab.svelte`
  /// returns `false` for this chord so the event bubbles out of
  /// xterm to the App-level keymap. Default false (xterm consumes
  /// the keystroke as a shell input). Set true on App-group chords
  /// (Settings, TeamWork, Reload, FB toggle, Graph, NewDraft,
  /// Hybrid Nav, etc.) that must reach App.svelte regardless of
  /// terminal focus.
  escapeTerminal?: boolean;
};

/// The complete chord registry. Order in this list is the order the
/// table renders rows within each group.
export const SHORTCUTS: readonly Shortcut[] = [
  // Command launcher: Cmd+K on native macOS, Ctrl+Alt+K on web and
  // on native Linux / Windows. The off-mac chord avoids stealing
  // plain Ctrl+K from readline shells.
  {
    id: "app.launcher.toggle",
    label: "Command launcher",
    web: "Ctrl+Alt+K",
    native: "Mod+K",
    group: "App",
    escapeTerminal: true,
  },
  {
    id: "app.launcher.computers",
    label: "Computers command launcher",
    native: "Mod+Shift+K",
    group: "App",
    note: "Desktop only",
    escapeTerminal: true,
  },
  {
    id: "app.settings.open",
    label: "Settings",
    web: "Mod+,",
    native: "Mod+,",
    group: "App",
    escapeTerminal: true,
  },
  {
    id: "app.search.toggle",
    label: "Search",
    web: "Mod+Shift+S",
    native: "Mod+Shift+S",
    group: "App",
    note: "Ctrl+Alt+S on Linux / Windows",
    escapeTerminal: true,
  },
  // File-browser destructive delete. Bare Backspace (the Mac "delete"
  // key) or forward-Delete removes the selected entry; the dispatch
  // source is FileTree's `onTreeKeydown`, with the uiConfirm in
  // `fileOps.remove` as the safety gate. Recorded here so the FB
  // selection-menu hint reads the chord from the central store
  // (`chordFor`) and it ports across web/native. No modifier, so it
  // never escapes the terminal (`chordFromEvent` ignores modifierless
  // keys); `escapeTerminal` stays false to keep shell Backspace intact.
  {
    id: "app.files.delete",
    label: "Delete file or directory",
    web: "Backspace",
    native: "Backspace",
    group: "File",
  },
  // New terminal in the active pane as a direct chord. Cmd+T on the macOS
  // desktop; Ctrl+Shift+T everywhere else (Linux / Windows desktop and every
  // browser), because plain Cmd+T / Ctrl+T is a new-tab or terminal chord. On
  // a browser Ctrl+Shift+T is the reopen-closed-tab chord, so browser clients
  // rebind; the desktop is the primary target. The off-mac native divergence
  // lives in `osChord`. Hybrid Nav `t` remains a universal alternate.
  {
    id: "app.terminal.toggle",
    label: "New terminal",
    web: "Ctrl+Shift+T",
    native: "Mod+T",
    group: "App",
    note: "Cmd+T on macOS desktop; or Mod+. t (Hybrid Nav)",
    escapeTerminal: true,
  },
  // Mod+. is not browser-reserved on macOS, so it survives both
  // web + native dispatch through the same chord descriptor.
  // Mod+, takes the macOS preferences convention (Settings),
  // leaving Mod+. for Hybrid Nav.
  {
    id: "app.pane.mode",
    label: "Hybrid Nav",
    web: "Mod+.",
    native: "Mod+.",
    group: "Panes",
    escapeTerminal: true,
  },
  {
    id: "app.pane.flip",
    label: "Flip pane side",
    web: "Ctrl+`",
    native: "Ctrl+`",
    group: "Panes",
    escapeTerminal: true,
  },
  // Window-level reload analogous to a browser Cmd+R. Routes
  // through `reloadWindow()` (chan-desktop IPC or
  // `window.location.reload()` on web). The Tauri-side binding
  // in chan-desktop's serve.rs is defense-in-depth.
  //
  // The stored chord is the macOS form (`Mod+R` -> Cmd+R). On
  // Linux/Windows plain Ctrl+R is the shell's reverse-search, so
  // reload diverges to Ctrl+Shift+R there. That divergence is real
  // (a different chord, not just a different label), so it lives in
  // `osChord` rather than the `Mod` token; the note documents it in
  // the macOS-rendered help table.
  {
    id: "app.window.reload",
    label: "Reload window",
    web: "Mod+R",
    native: "Mod+R",
    group: "App",
    note: "Ctrl+Shift+R on Linux / Windows",
    escapeTerminal: true,
  },
  // Pane nav splits per platform. Desktop-native keeps Cmd+[/]
  // (no browser chrome to fight). The web build uses Alt+[/]
  // because Cmd+[/] is browser back/forward. Tab nav mirrors
  // this split (web Alt+Shift+[/], native Cmd+Shift+[/]). The
  // web handler matches by `e.code` and preventDefaults the
  // Option-mangled glyph, same as the tab handler.
  {
    id: "app.pane.prev",
    label: "Previous pane",
    web: "Alt+[",
    native: "Mod+[",
    group: "Panes",
    escapeTerminal: true,
  },
  {
    id: "app.pane.next",
    label: "Next pane",
    web: "Alt+]",
    native: "Mod+]",
    group: "Panes",
    escapeTerminal: true,
  },
  // Split-active chords use Ctrl+Alt on web because Ctrl+/ is claimed by
  // terminals and editor comment-toggle. Split-bottom is Cmd+Shift+/ rather
  // than Cmd+\ on native because 1Password registers Cmd+\ as a system-wide
  // macOS hotkey that the OS dispatches before the keystroke reaches chan's
  // webview. The mnemonic is `/` right, `?` bottom (same physical key with or
  // without Shift). Hybrid Nav mirrors it.
  {
    id: "app.pane.splitRight",
    label: "Split right",
    web: "Ctrl+Alt+/",
    native: "Mod+/",
    group: "Panes",
    escapeTerminal: true,
  },
  {
    id: "app.pane.splitDown",
    label: "Split bottom",
    web: "Ctrl+Alt+?",
    native: "Mod+Shift+/",
    group: "Panes",
    escapeTerminal: true,
  },
  // The explicit "close this window" action. Native chord: Cmd+Shift+W on
  // macOS, Ctrl+Alt+W on Linux / Windows (via `osChord`; Ctrl+Shift+W is
  // tab close there). There is no in-page web chord:
  // on the web a browser tab close IS the discard. chan-desktop binds the
  // native chord and maps the OS close button here when a devserver is NOT
  // connected (when connected the button buries the window instead, serve.rs).
  // Drives the window-discard path (an explicit DELETE of the saved window
  // blob), distinct from the tab-close chords (Cmd+W on macOS, Ctrl+Shift+W
  // on the Linux / Windows desktop via `osChord`, Ctrl+D everywhere).
  {
    id: "app.window.close",
    label: "Close window",
    native: "Mod+Shift+W",
    group: "App",
    note: "discard an empty / terminal window; buries when devserver-connected",
    escapeTerminal: true,
  },
  // The explicit "hide this window" action: the close-confirm overlay's Hide
  // answer without the prompt. Buries the window via the desktop IPC --
  // sessions stay warm, the record persists hidden and reopens from the
  // launcher. Desktop-only like Close window: the bury IPC is an explicit
  // no-op in a plain browser, so no web chord is minted. The stored Mod
  // renders Cmd+Shift+H on macOS and Ctrl+Shift+H on Linux / Windows.
  {
    id: "app.window.hide",
    label: "Hide window",
    native: "Mod+Shift+H",
    group: "App",
    note: "bury this window; reopen it from the launcher",
    escapeTerminal: true,
  },
  {
    id: "ui.overlay.dismiss",
    label: "Dismiss overlay",
    web: "Esc",
    native: "Esc",
    group: "App",
  },
  // Tab navigation
  //
  // Close tab: Cmd+W is the primary on macOS and Ctrl+Shift+W the primary
  // on the Linux / Windows desktop; both live in `osChord`. Ctrl+D is the
  // alternate on every platform (it works everywhere except Excalidraw,
  // which reserves Ctrl+D for duplicate-object and wins on that tab). The
  // stored Ctrl+D is what web renders. No escapeTerminal: Ctrl+D must
  // still reach a focused shell as EOF.
  {
    id: "app.tab.close",
    label: "Close tab",
    web: "Ctrl+D",
    native: "Ctrl+D",
    group: "Tabs",
    note: "Cmd+W on macOS, Ctrl+Shift+W on the Linux / Windows desktop",
  },
  // Reopen closed tab: Cmd+Shift+T on the macOS desktop; Ctrl+Alt+Shift+T on
  // web and the Linux / Windows desktop, because plain Ctrl+Shift+T is the
  // browser's own reopen-tab chord and the New-terminal desktop chord, so
  // reopen takes the Alt form. The off-mac native divergence lives in
  // `osChord`.
  {
    id: "app.tab.reopenClosed",
    label: "Reopen closed tab",
    web: "Ctrl+Alt+Shift+T",
    native: "Mod+Shift+T",
    group: "Tabs",
    note: "Cmd+Shift+T on macOS desktop",
    escapeTerminal: true,
  },
  {
    id: "app.tab.next",
    label: "Next tab",
    web: "Alt+Shift+]",
    native: "Mod+Shift+]",
    group: "Tabs",
    escapeTerminal: true,
  },
  {
    id: "app.tab.prev",
    label: "Previous tab",
    web: "Alt+Shift+[",
    native: "Mod+Shift+[",
    group: "Tabs",
    escapeTerminal: true,
  },
  {
    id: "app.tab.jump",
    label: "Jump to tab N",
    web: "Ctrl+Alt+1..9",
    native: "Mod+1..9",
    group: "Tabs",
    escapeTerminal: true,
  },
  // Find on page - browser owns Cmd+F/G/Shift+G in the web build.
  {
    id: "app.find.open",
    label: "Find on page",
    native: "Mod+F",
    group: "Find",
    note: "browser's own find dialog on web",
  },
  {
    id: "app.find.next",
    label: "Find next",
    native: "Mod+G",
    group: "Find",
  },
  {
    id: "app.find.prev",
    label: "Find previous",
    native: "Mod+Shift+G",
    group: "Find",
  },
  // Obsidian-style "Show Source Code" toggle. Cmd+E flips the
  // active editor tab between its rendered surface (wysiwyg /
  // pretty / table) and the raw source view. Web Mac has no
  // browser-reserved conflict on Cmd+E, so web and native share
  // Mod+E.
  {
    id: "app.editor.toggleMode",
    label: "Show Source Code (toggle rendered/source)",
    native: "Mod+E",
    web: "Mod+E",
    group: "Editor",
    // escapeTerminal stays FALSE: off macOS `Mod` is Ctrl, and Ctrl+E is
    // readline's move-to-end-of-line, which a focused terminal must keep.
    // Escaping bought nothing here anyway - the toggle targets the active
    // FILE tab, so from a focused terminal pane (no file tab) it is a no-op.
    // The editor reaches the chord directly (it is not a terminal), so the
    // Show Source toggle still fires when a file tab is focused.
    escapeTerminal: false,
  },
  // Bold + Italic are bound in the editor's CM6 keymap
  // (Wysiwyg.svelte -> fmt.toggleBold/Italic). These entries exist
  // for cheatsheet + StyleToolbar tooltip discoverability; the
  // editor keymap is the dispatch source, so no `escapeTerminal`
  // (CM6 keystrokes never route through the terminal escape path).
  {
    id: "app.editor.bold",
    label: "Bold",
    native: "Mod+B",
    web: "Mod+B",
    group: "Editor",
  },
  {
    id: "app.editor.italic",
    label: "Italic",
    native: "Mod+I",
    web: "Mod+I",
    group: "Editor",
  },
  // Slide deck preview / present. Dispatched by FileEditorTab's
  // `onSlideShortcutKeydown` (a capture-phase handler on the wysiwyg and
  // source editor hosts), NOT by the App keymap; these entries exist for
  // cheatsheet / launcher / Settings-grid discoverability and for
  // conflict detection, on the Bold / Italic precedent above. The same
  // chord on every platform, so no `osChord` divergence. The capture
  // claim covers only this built-in shape and goes inert once the action
  // is rebound (`builtInChordSuperseded`); a user-assigned chord
  // dispatches through the App-level override path into the
  // mountedEditors seam. Both fields are set even though they match -
  // `osChord` drops a row whose platform field is absent.
  {
    id: "app.slides.preview",
    label: "Preview slide deck",
    native: "Mod+Enter",
    web: "Mod+Enter",
    group: "Editor",
  },
  {
    id: "app.slides.present",
    label: "Present slide deck fullscreen",
    native: "Mod+Shift+Enter",
    web: "Mod+Shift+Enter",
    group: "Editor",
  },
  // Terminal copy / paste. The ONE family whose chord can't use the `Mod`
  // token: `Mod+C` resolves to Ctrl+C on Linux / Windows, which is the
  // shell's SIGINT. So macOS uses literal Cmd+C / Cmd+V (Cmd never collides
  // with a control code) and every other platform uses the standard terminal
  // Ctrl+Shift+C / Ctrl+Shift+V, leaving bare Ctrl+C/V for the shell. Handled
  // terminal-locally in TerminalTab (handleTerminalClipboardChord), NOT via
  // the App-level keymap, so no `escapeTerminal` flag (same as Find). The
  // displayed hint is correct on macOS; the `note` documents the Linux /
  // Windows divergence the handler implements.
  {
    id: "terminal.copy",
    label: "Copy selection",
    web: "Cmd+C",
    native: "Cmd+C",
    group: "Terminal",
    note: "Ctrl+Shift+C on Linux / Windows",
  },
  {
    id: "terminal.paste",
    label: "Paste",
    web: "Cmd+V",
    native: "Cmd+V",
    group: "Terminal",
    note: "Ctrl+Shift+V on Linux / Windows",
  },
  // Rich Prompt toggle for the focused pane's active terminal (workspace
  // windows only; no-op when the focused tab is not a terminal). Dispatched by
  // App.svelte's onWindowKey; the terminal right-click menu mirrors it and
  // reads its label via `chordFor`. Cmd+Shift+P on macOS; Ctrl+Shift+P on every
  // other surface (Linux / Windows desktop and browsers), since off macOS the
  // Win / Super key is ruled out. On a browser Ctrl+Shift+P is the private-
  // window chord, so browser clients rebind. The registry stores the macOS form.
  {
    id: "terminal.richPrompt",
    label: "Show/Hide Rich Prompt",
    web: "Cmd+Shift+P",
    native: "Cmd+Shift+P",
    group: "Terminal",
    note: "Ctrl+Shift+P on Linux / Windows",
    escapeTerminal: true,
  },
  // Broadcast select-all / deselect-all for the focused terminal's group
  // (no-op when the focused tab is not a terminal). Dispatched by
  // App.svelte's onWindowKey; the terminal right-click row and the
  // launcher entry read the label via `chordFor`. Cmd+Shift+I on the
  // macOS desktop only: off macOS Ctrl+Shift+I is the webview / browser
  // inspector chord, so `osChord` blanks it there and those surfaces
  // bind through user overrides instead.
  {
    id: "app.terminal.broadcastToggle",
    label: "Toggle group broadcast",
    native: "Cmd+Shift+I",
    group: "Terminal",
    note: "macOS desktop only",
    escapeTerminal: true,
  },
  // Terminal-local find (the terminal's own find bar). Dispatched by
  // the terminal's keydown handler like copy / paste, not the App
  // keymap; the handler accepts both the Cmd and Ctrl forms.
  {
    id: "terminal.find",
    label: "Find in terminal",
    web: "Mod+F",
    native: "Mod+F",
    group: "Terminal",
  },
];

// Editor strikethrough / inline-code chords are not in this registry:
// strike (Cmd+Shift+S) is owned by the editor keymap directly and
// inline code remains a click-only target in StyleToolbar.svelte.
// Bold (Cmd+B) + Italic (Cmd+I) are in the registry above because
// the editor keymap binds them and tooltips need to discover them.

const MOD_LABEL: Record<OS, string> = {
  mac: "Cmd",
  linux: "Ctrl",
  windows: "Ctrl",
};

/// Replace `Mod` with the OS-appropriate label. Leaves explicit
/// `Ctrl` alone so a "Ctrl+Alt+N" chord (the web fallback) stays
/// literal even on macOS.
export function formatChord(chord: Chord, os: OS): string {
  return chord.replaceAll(/\bMod\b/g, MOD_LABEL[os]);
}

/// Shortcuts whose chord diverges by OS or surface, not just by label (macOS
/// keeps the stored chord; other platforms get a DIFFERENT chord because the
/// macOS one collides with a control code, a browser chord, or is unreachable).
const RELOAD_SHORTCUT_ID = "app.window.reload";
const LAUNCHER_SHORTCUT_ID = "app.launcher.toggle";
const TERMINAL_COPY_ID = "terminal.copy";
const TERMINAL_PASTE_ID = "terminal.paste";
const RICH_PROMPT_ID = "terminal.richPrompt";
const BROADCAST_TOGGLE_ID = "app.terminal.broadcastToggle";
const TAB_CLOSE_ID = "app.tab.close";
const WINDOW_CLOSE_ID = "app.window.close";
const TERMINAL_TOGGLE_ID = "app.terminal.toggle";
const TAB_REOPEN_ID = "app.tab.reopenClosed";
const SEARCH_TOGGLE_ID = "app.search.toggle";
const COMPUTERS_LAUNCHER_ID = "app.launcher.computers";

/// Resolve a shortcut's chord for a platform with chan's OS-level chord
/// overrides applied. Most chords differ only by LABEL (`Mod` -> Cmd/Ctrl);
/// a few diverge into a different chord entirely:
///   - Reload: Cmd+R (mac) vs Ctrl+Shift+R (plain Ctrl+R is the shell's
///     reverse-search).
///   - Command launcher: Cmd+K (native macOS) vs Ctrl+Alt+K (web and
///     off-mac native; plain Ctrl+K is a shell editing chord).
///   - Terminal copy / paste: Cmd+C/V (mac) vs Ctrl+Shift+C/V (bare Ctrl+C/V
///     is the shell's SIGINT / EOF). TerminalTab's clipboard handler splits on
///     the same rule at the event layer; this keeps the displayed hint + the
///     help table correct per-OS.
///   - Rich Prompt: Cmd+Shift+P (mac) vs Ctrl+Shift+P off-mac (native + web;
///     the Win / Super key is ruled out).
///   - Close tab: Cmd+W (mac native) vs Ctrl+Shift+W (off-mac native;
///     plain Ctrl+W is readline delete-word in a shell). Web keeps the
///     stored Ctrl+D, the off-mac alternate everywhere but Excalidraw.
///   - Close window: Cmd+Shift+W (mac native) vs Ctrl+Alt+W (off-mac
///     native), so the off-mac tab-close chord never means two things.
///   - New terminal: Cmd+T (mac native) vs Ctrl+Shift+T (off-mac native).
///   - Reopen closed tab: Cmd+Shift+T (mac native) vs Ctrl+Alt+Shift+T
///     (off-mac native; the web set already stores that form).
///   - Search: Cmd+Shift+S on macOS, Ctrl+Alt+S off macOS.
/// This function is the ONE place OS-level divergence lives, so the escape
/// matcher, the on-screen labels, and the help table all agree. App.svelte's
/// keymap and chan-desktop's KEY_BRIDGE_JS branch on the same rule at the
/// raw-event layer.
export function osChord(
  s: Shortcut,
  platform: Platform,
  os: OS,
): Chord | undefined {
  const chord = s[platform];
  if (!chord) return undefined;
  if (s.id === RELOAD_SHORTCUT_ID && os !== "mac") return "Mod+Shift+R";
  if (s.id === LAUNCHER_SHORTCUT_ID && platform === "native" && os !== "mac") {
    return "Ctrl+Alt+K";
  }
  if (s.id === COMPUTERS_LAUNCHER_ID && platform === "native" && os !== "mac") {
    return "Ctrl+Alt+Shift+K";
  }
  if (s.id === TERMINAL_COPY_ID && os !== "mac") return "Mod+Shift+C";
  if (s.id === TERMINAL_PASTE_ID && os !== "mac") return "Mod+Shift+V";
  // Rich Prompt: Cmd+Shift+P on macOS. Off macOS the Win / Super key is ruled
  // out, so native and web both take Ctrl+Shift+P. On a browser that is the
  // private-window chord, so browser clients rebind (desktop-first).
  if (s.id === RICH_PROMPT_ID && os !== "mac") return "Mod+Shift+P";
  // Group broadcast: macOS desktop only. Off macOS Ctrl+Shift+I is the
  // webview / browser inspector chord, so no default is minted there.
  if (s.id === BROADCAST_TOGGLE_ID && os !== "mac") return undefined;
  // Close tab: Cmd+W is the macOS-native primary; Ctrl+Shift+W is the
  // Linux / Windows desktop primary (plain Ctrl+W stays readline
  // delete-word in a focused shell, unclaimed). Web keeps the stored
  // Ctrl+D, which also remains the off-mac desktop alternate (the SPA's
  // onCtrlDCapture claims it, context-aware).
  if (s.id === TAB_CLOSE_ID && platform === "native") {
    return os === "mac" ? "Mod+W" : "Ctrl+Shift+W";
  }
  // Close window: Cmd+Shift+W is the macOS primary (the stored native
  // chord). Off-mac native moves with the launcher accelerator to
  // Ctrl+Alt+W, the established off-mac substitute family, so
  // Ctrl+Shift+W never means two things depending on focus.
  if (s.id === WINDOW_CLOSE_ID && platform === "native" && os !== "mac") {
    return "Ctrl+Alt+W";
  }
  // New terminal: Cmd+T on the macOS desktop; Ctrl+Shift+T on the Linux /
  // Windows desktop, where bare Ctrl+T is a terminal chord.
  if (s.id === TERMINAL_TOGGLE_ID && platform === "native" && os !== "mac") {
    return "Mod+Shift+T";
  }
  // Reopen closed tab: Cmd+Shift+T on the macOS desktop; Ctrl+Alt+Shift+T on
  // the Linux / Windows desktop, where Ctrl+Shift+T is the New-terminal chord
  // and the browser's own reopen. The web set already stores that Alt form.
  if (s.id === TAB_REOPEN_ID && platform === "native" && os !== "mac") {
    return "Ctrl+Alt+Shift+T";
  }
  if (s.id === SEARCH_TOGGLE_ID && os !== "mac") return "Ctrl+Alt+S";
  return chord;
}

export function currentOS(): OS {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}

/// Runtime hook the persisted keymap-override layer installs so
/// `chordFor` resolves a user-assigned chord before the built-in
/// `SHORTCUTS`. Returns the raw override chord (registry grammar, e.g.
/// `"Mod+J"`) for `id` on the given platform + OS, or a nullish value
/// when the command has no override there.
///
/// Injected rather than statically imported so this module stays free
/// of the reactive override store: `scripts/shortcuts-table.mjs`
/// compiles `shortcuts.ts` in isolation, and `renderTable` must resolve
/// only the built-in chords. With no resolver registered (the generator
/// and the unit tests) every override lookup is inert, so `chordFor`
/// behaves exactly as it does over the bare registry.
export type OverrideResolver = (
  id: string,
  platform: Platform,
  os: OS,
) => Chord | null | undefined;

let overrideResolver: OverrideResolver | null = null;

export function registerOverrideResolver(fn: OverrideResolver | null): void {
  overrideResolver = fn;
}

/// Runtime hook the override layer installs so a focused terminal escapes a
/// user-assigned chord. A de-defaulted command has no `escapeTerminal`
/// registry entry to match, so without this its assigned chord would be
/// swallowed by xterm instead of bubbling to the App keymap. Given a captured
/// chord in registry grammar, returns true when it maps to a user override on
/// the current client. Injected like the resolver so `shortcuts.ts` stays free
/// of the reactive store and the standalone table generator compiles it in
/// isolation; with no matcher registered the override-escape path is inert.
export type OverrideEscapeMatcher = (chord: Chord) => boolean;

let overrideEscapeMatcher: OverrideEscapeMatcher | null = null;

export function registerOverrideEscapeMatcher(
  fn: OverrideEscapeMatcher | null,
): void {
  overrideEscapeMatcher = fn;
}

/// Return the formatted chord for a command id on the current platform
/// + OS: the user-assigned override if one exists, otherwise the
/// built-in chord, or `null` when neither is wired. Chordless commands
/// (no `SHORTCUTS` entry) resolve to their override when assigned.
/// Tooltips, menu rows, and the launcher use this to stay in sync with
/// the keymap layer without duplicating chord strings inline.
export function chordFor(id: string): string | null {
  const os = currentOS();
  const platform = currentPlatform();
  const override = overrideResolver?.(id, platform, os);
  if (override) return formatChord(override, os);
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) return null;
  const chord = osChord(s, platform, os);
  if (!chord) return null;
  return formatChord(chord, os);
}

/// Derive the platform-resolved chord from a raw `KeyboardEvent`.
/// Used by `handleTerminalKeyEvent` to detect whether the incoming
/// keystroke matches an `escapeTerminal` shortcut and should bubble
/// out of xterm.
///
/// Returns a chord string of the same shape the registry uses
/// (e.g. `"Mod+P"`, `"Cmd+Alt+P"`, `"Ctrl+Alt+1"`). `Mod` is
/// emitted for `metaKey` on macOS + `ctrlKey` on Linux/Windows;
/// `Cmd` is emitted for `metaKey` regardless of platform when
/// `ctrlKey` is also present-or-absent. Keys are normalised to
/// the registry's casing (`P`, `Enter`, `[`, etc.).
///
/// `null` when the event carries no modifier OR the key isn't a
/// recognisable shortcut surface (printable characters typed
/// into the editor don't match anything in the registry).
export function chordFromEvent(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  const os = currentOS();
  // `Mod` semantics: Cmd on macOS, Ctrl elsewhere. Emit `Mod`
  // when the platform-canonical modifier fires; emit `Cmd` /
  // `Ctrl` separately when the *non-platform* form fires (the
  // Cmd+Alt+P web-Mac fallback always uses `Cmd+...`).
  const modIsMeta = os === "mac";
  const hasPlatformMod = modIsMeta ? e.metaKey : e.ctrlKey;
  const hasNonPlatformMeta = modIsMeta ? false : e.metaKey;
  const hasNonPlatformCtrl = modIsMeta ? e.ctrlKey : false;
  if (hasPlatformMod) parts.push("Mod");
  if (hasNonPlatformMeta) parts.push("Cmd");
  if (hasNonPlatformCtrl) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = canonicalKey(e);
  if (!key) return null;
  parts.push(key);
  if (parts.length <= 1) return null;
  return parts.join("+");
}

/// Normalise a keydown to the registry's physical-key casing. App.svelte's
/// global handlers match `code` so Option-mangled and non-US-layout glyphs
/// still trigger their advertised chord; terminal escape must use the same
/// identity or xterm/ghostty will consume the event before App sees it.
function canonicalKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || k === "Shift" || k === "Alt" || k === "Control" || k === "Meta") {
    return null;
  }
  const letter = e.code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;
  const digit = e.code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;
  const physicalPunctuation: Readonly<Record<string, string>> = {
    Backquote: "`",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Period: ".",
    Semicolon: ";",
    Slash: "/",
  };
  const punctuation = physicalPunctuation[e.code];
  if (punctuation) return punctuation;
  if (k.length === 1) return k.toUpperCase();
  // Multi-char keys: registry uses the browser's `KeyboardEvent.key`
  // names verbatim (`Enter`, `Tab`, `Escape`, `ArrowLeft`, ...).
  return k;
}

/// Chord-escape lookup. Returns true when the incoming `KeyboardEvent`
/// matches a user-assigned override chord OR any registry entry flagged
/// `escapeTerminal: true`.
///
/// The override arm keeps a rebound command reachable from terminal focus even
/// after its built-in default (and its `escapeTerminal` flag) is gone.
///
/// The registry arm matches BOTH the platform-resolved chord AND the
/// cross-platform `Cmd+` literal alias (the registry's `Mod`
/// expands to Cmd on Mac + Ctrl elsewhere; `Cmd+` is the
/// literal Cmd key used by the web-fallback chords). The
/// matcher normalises both sides to a canonical token set so
/// `Mod+Alt+P` (event) === `Cmd+Alt+P` (registry web Mac
/// fallback) on Mac.
export function shouldEscapeTerminal(e: KeyboardEvent): boolean {
  const chord = chordFromEvent(e);
  if (!chord) return false;
  if (overrideEscapeMatcher?.(chord)) return true;
  return registryEscapeCommandId(chord) !== null;
}

function registryEscapeCommandId(chord: Chord): string | null {
  const eventTokens = canonicalChordTokens(chord);
  const platform = currentPlatform();
  const os = currentOS();
  for (const s of SHORTCUTS) {
    if (!s.escapeTerminal) continue;
    const registryChord = osChord(s, platform, os);
    if (!registryChord) continue;
    const override = overrideResolver?.(s.id, platform, os);
    if (override && !chordsEqual(override, registryChord)) continue;
    const registryTokens = canonicalChordTokens(registryChord);
    if (registryTokens.has("1..9")) {
      const eventDigit = [...eventTokens].find((token) => /^[1-9]$/.test(token));
      if (eventDigit) {
        registryTokens.delete("1..9");
        registryTokens.add(eventDigit);
      }
    }
    if (sameChord(eventTokens, registryTokens)) {
      return s.id;
    }
  }
  return null;
}

/// Normalise a chord string into a Set-shape comparable across
/// physical modifier aliases. On Mac, `Mod` and `Cmd` are the same
/// key. Off Mac, `Mod` and `Ctrl` are the same key; this lets literal
/// Ctrl+Alt web fallbacks escape xterm even though raw events first
/// normalise platform Ctrl as `Mod`.
function canonicalChordTokens(chord: string): Set<string> {
  const tokens = new Set(chord.split("+"));
  // `?` already implies Shift in the human-facing chord grammar. Events use
  // the physical Slash code plus shiftKey, so compare both as Shift+/.
  if (tokens.has("?")) {
    tokens.delete("?");
    tokens.add("Shift");
    tokens.add("/");
  }
  if (currentOS() === "mac" && tokens.has("Cmd")) {
    tokens.delete("Cmd");
    tokens.add("Mod");
  }
  if (currentOS() !== "mac" && tokens.has("Ctrl")) {
    tokens.delete("Ctrl");
    tokens.add("Mod");
  }
  return tokens;
}

function sameChord(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/// Whether two chord strings denote the same keystroke on the current
/// OS, tolerant of the `Mod` / `Cmd` / `Ctrl` aliases (on mac `Mod` and
/// `Cmd` are one key; off mac `Mod` and `Ctrl` are one key). The keymap
/// override layer uses this to compare a captured chord against the
/// resolved keymap for conflict detection and reverse dispatch, so a
/// stored `Mod+J` matches a built-in `Cmd+J` on macOS.
export function chordsEqual(a: Chord, b: Chord): boolean {
  return sameChord(canonicalChordTokens(a), canonicalChordTokens(b));
}

/// Tauri injects `window.__TAURI_INTERNALS__` (newer versions) or
/// `window.__TAURI__` (older). Either marker means we're inside the
/// native shell and chan-desktop's init script owns the OS-reserved
/// chords; web fallbacks are inert.
export function currentPlatform(): Platform {
  if (typeof window === "undefined") return "web";
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return "native";
  return "web";
}

/// Continuation indent for a note that will not fit beside its chord.
/// Small enough that even the longest note clears any sane column budget,
/// and deep enough to read as a continuation rather than a new row.
const NOTE_CONTINUATION_INDENT = "    ";

/// Render the shortcuts visible on `platform` as a plain-ASCII table,
/// with `Mod` formatted for `os`. Each group becomes an underlined
/// subheader followed by `label  chord` rows, the column gap derived
/// from the longest label. No box-drawing, no Unicode - matches the
/// project's writing rules.
///
/// Output feeds the empty-pane background AND the `chan serve --help`
/// text; resync the latter via `node
/// web/packages/workspace-app/scripts/shortcuts-table.mjs
/// --serve-long-about`.
///
/// `maxWidth` caps the column budget: a row whose trailing `(note)` would
/// push it past the cap moves that note to its own indented line. The
/// `chan serve` help passes a cap because clap prints help verbatim (the
/// workspace pins clap without `wrap_help`), so an over-long row is an
/// over-long row in the user's terminal. Callers with no column limit omit
/// it and keep every note inline.
export function renderTable(
  platform: Platform,
  os: OS,
  maxWidth?: number,
): string {
  const groups = new Map<ShortcutGroup, Shortcut[]>();
  for (const s of SHORTCUTS) {
    // Resolve through osChord so an entry blanked for this OS (e.g. the
    // macOS-only group-broadcast chord) drops its row entirely.
    const chord = osChord(s, platform, os);
    if (!chord) continue;
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  // Width = longest label across all visible rows so every group's
  // chord column lines up at the same column.
  let labelW = 0;
  for (const arr of groups.values()) {
    for (const s of arr) {
      if (s.label.length > labelW) labelW = s.label.length;
    }
  }
  const gap = "    ";
  const lines: string[] = [];
  for (const [name, arr] of groups) {
    lines.push(name);
    lines.push("-".repeat(name.length));
    for (const s of arr) {
      const label = s.label.padEnd(labelW);
      const chord = formatChord(osChord(s, platform, os)!, os);
      const row = `${label}${gap}${chord}`;
      if (!s.note) {
        lines.push(row);
        continue;
      }
      const suffix = `   (${s.note})`;
      if (maxWidth !== undefined && row.length + suffix.length > maxWidth) {
        lines.push(row);
        lines.push(`${NOTE_CONTINUATION_INDENT}(${s.note})`);
      } else {
        lines.push(`${row}${suffix}`);
      }
    }
    lines.push("");
  }
  // Drop the trailing blank line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
