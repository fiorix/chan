// The window tab bar: a band across the top of the window holding the pane
// tree button and the active pane's tab strip, which no pane then draws in
// place. In chan-desktop on macOS and Windows the band is the window's title
// bar: on macOS the traffic lights sit in its left inset, and on Windows the
// window has no frame and the bar draws the window controls in its right
// inset.
//
// The page decides the mode and the desktop never forces it. A stored
// override wins; without one the bar follows the desktop's own preference,
// off by default, which Settings writes and which every window of the
// desktop follows live, and it is drawn only in chan-desktop on macOS or
// Windows when the installed app advertises the commands that host needs. In
// a browser, and wherever the title bar is out of reach, a forced bar is a
// plain top bar with no insets. On Windows a window in the mode wears no
// menubar, so while the Computers launcher covers the page the bar draws the
// menus the desktop's chrome lists.

import {
  isTauriDesktop,
  onTauriEvent,
  readTitlebarChrome,
  readTitlebarTabsPreference,
  setTitlebarTabs,
  writeTitlebarTabsPreference,
  type TitlebarChrome,
  type TitlebarMenu,
} from "../api/desktop";
import { hostVocabulary } from "../api/nativeVocabulary";
import { currentOS, type OS } from "./shortcuts";

/// `"1"` forces the bar on in any host and `"0"` forces it off, whatever the
/// desktop's preference; no value leaves the choice to the preference.
export const WINDOW_TAB_BAR_STORAGE_KEY = "chan.windowTabBar";

/// The desktop command whose advertisement says the installed app can put
/// a window's tabs in its title bar.
export const TITLEBAR_TABS_COMMAND = "set_titlebar_tabs";

/// The desktop command behind the window controls the bar draws on Windows;
/// its advertisement says the installed app takes their presses.
export const TITLEBAR_WINDOW_CONTROL_COMMAND = "titlebar_window_control";

/// The commands the installed app must advertise before a window on `os` puts
/// its tabs in the title bar, or null where it cannot. On Windows the window
/// has no frame in the mode, so an app that cannot take the bar's window
/// controls would leave it without minimize, maximize and close.
export function titlebarTabsCommands(os: OS): readonly string[] | null {
  if (os === "mac") return [TITLEBAR_TABS_COMMAND];
  if (os === "windows") return [TITLEBAR_TABS_COMMAND, TITLEBAR_WINDOW_CONTROL_COMMAND];
  return null;
}

/// Whether a chan-desktop window on `os` whose app advertises `vocabulary`
/// (null when it cannot say) can put its tabs in the title bar.
export function titlebarTabsSupported(os: OS, vocabulary: ReadonlySet<string> | null): boolean {
  const commands = titlebarTabsCommands(os);
  if (!commands || !vocabulary) return false;
  return commands.every((command) => vocabulary.has(command));
}

/// The event chan-desktop emits to every window when its preference changes.
/// Its payload is `{ on }`.
export const TITLEBAR_TABS_PREFERENCE_EVENT = "titlebar-tabs-preference";

/// The event chan-desktop sends a frameless window's page with the window's
/// title while the window's Computers launcher shows, and again on a rename.
/// Its payload is `{ title }`.
export const TITLEBAR_WINDOW_TITLE_EVENT = "titlebar-window-title";

/// The bar's height in CSS px where no window controls set it, in a browser:
/// room for the strip's tab pills, side toggle and pane menu.
export const WINDOW_TAB_BAR_MIN_HEIGHT = 38;

/// The height in CSS px of the bar's content row: the strip's tab pills, side
/// toggle and pane menu with a little room. Beside the window controls the
/// band is no taller than this row or the controls' own band.
export const WINDOW_TAB_BAR_ROW_HEIGHT = 28;

/// How long the boot holds the layout restore for the desktop's answer. The
/// invokes answer in milliseconds; the bound keeps a desktop that never
/// answers from holding the window's boot.
export const WINDOW_TAB_BAR_BOOT_WAIT_MS = 400;

/// Fullscreen transitions and zoom changes arrive as a burst of resizes; the
/// chrome is asked for once the burst settles.
const RESIZE_DEBOUNCE_MS = 50;

export type WindowTabBarOverride = "on" | "off" | null;

export const NO_TITLEBAR_CHROME: TitlebarChrome = {
  active: false,
  insetLeft: 0,
  insetRight: 0,
  controlsCenterY: 0,
  fullscreen: false,
  drawControls: false,
  maximized: false,
  menus: [],
};

/// `on` is the mode; `available` whether this window can put its tabs in the
/// title bar (chan-desktop on macOS or Windows whose app advertises the
/// commands that host needs), which is when Settings offers the preference;
/// `preferred` the desktop's preference; `chrome` what the desktop reports
/// about the title bar (all zero off the desktop); `height` the bar's height
/// in CSS px; `slot` the bar element the active pane's strip moves into, null
/// while no bar is mounted; `title` the window's title the desktop last sent,
/// which the bar draws while the Computers launcher covers a window whose
/// controls it draws, empty until then.
export const windowTabBar = $state<{
  on: boolean;
  available: boolean;
  preferred: boolean;
  chrome: TitlebarChrome;
  height: number;
  slot: HTMLElement | null;
  title: string;
}>({
  on: false,
  available: false,
  preferred: false,
  chrome: NO_TITLEBAR_CHROME,
  height: WINDOW_TAB_BAR_MIN_HEIGHT,
  slot: null,
  title: "",
});

export function readWindowTabBarOverride(): WindowTabBarOverride {
  try {
    const value = globalThis.localStorage?.getItem(WINDOW_TAB_BAR_STORAGE_KEY);
    if (value === "1") return "on";
    if (value === "0") return "off";
  } catch {
    // Storage blocked (a private window, a sandboxed frame): no override.
  }
  return null;
}

/// Whether the page wants the bar. `os` is the host's, `vocabulary` what the
/// installed app advertises, null when it cannot say; `preferred` is the
/// desktop's preference.
export function windowTabBarWanted(input: {
  override: WindowTabBarOverride;
  desktop: boolean;
  os: OS;
  vocabulary: ReadonlySet<string> | null;
  preferred: boolean;
}): boolean {
  if (input.override === "on") return true;
  if (input.override === "off") return false;
  return input.preferred && input.desktop && titlebarTabsSupported(input.os, input.vocabulary);
}

/// The desktop's answer with every field present and finite, whatever an
/// app of another version sent. A menu without a non-empty id and label is
/// dropped, and an app that lists none offers none.
export function normalizeTitlebarChrome(raw: unknown): TitlebarChrome {
  const value = (raw ?? {}) as Partial<Record<keyof TitlebarChrome, unknown>>;
  const length = (n: unknown): number =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  const text = (s: unknown): s is string => typeof s === "string" && s !== "";
  const menus: TitlebarMenu[] = Array.isArray(value.menus)
    ? value.menus.flatMap((entry: unknown) => {
        const menu = (entry ?? {}) as { id?: unknown; label?: unknown };
        return text(menu.id) && text(menu.label) ? [{ id: menu.id, label: menu.label }] : [];
      })
    : [];
  return {
    active: value.active === true,
    insetLeft: length(value.insetLeft),
    insetRight: length(value.insetRight),
    controlsCenterY: length(value.controlsCenterY),
    fullscreen: value.fullscreen === true,
    drawControls: value.drawControls === true,
    maximized: value.maximized === true,
    menus,
  };
}

/// The bar's height for `chrome`: the content row's, or the band the window
/// controls take (twice their centre), whichever is taller, so no empty strip
/// sits under the tabs. The controls keep their size in points while the page
/// zoom scales CSS px, so a zoomed-in page's row outgrows their band.
export function windowTabBarHeight(chrome: TitlebarChrome): number {
  const center = chrome.controlsCenterY;
  return center > 0
    ? Math.max(WINDOW_TAB_BAR_ROW_HEIGHT, Math.ceil(center * 2))
    : WINDOW_TAB_BAR_MIN_HEIGHT;
}

/// Space the bar keeps below its content row so the row's centre line, and
/// with it the tab pills', is the window controls' centre line. A row taller
/// than the controls' band keeps none and fills the bar from its top. Zero
/// without controls, which centres the row in the bar.
export function windowTabBarCenterPad(chrome: TitlebarChrome, height: number): number {
  const center = chrome.controlsCenterY;
  if (center <= 0) return 0;
  return Math.max(0, Math.min(height - center * 2, height - WINDOW_TAB_BAR_ROW_HEIGHT));
}

/// Attach to the bar element that hosts the active pane's strip.
export function windowTabBarSlot(node: HTMLElement): () => void {
  windowTabBar.slot = node;
  return () => {
    if (windowTabBar.slot === node) windowTabBar.slot = null;
  };
}

/// Store the desktop's preference from Settings. The desktop tells every
/// window, this one included, and each switches when it hears. Rejects on an
/// IPC or ACL refusal so the Settings field can show it.
export async function setWindowTabBarPreference(on: boolean): Promise<void> {
  const stored = await writeTitlebarTabsPreference(on);
  windowTabBar.preferred = stored === true;
}

export type WindowTabBarStart = {
  /// Settles once the mode and the desktop's chrome are known; null when
  /// both were known at once, which is everywhere but chan-desktop.
  pending: Promise<void> | null;
  stop(): void;
};

let generation = 0;

/// Decide the mode for this page and, in chan-desktop, opt in or out of the
/// overlay title bar, then follow the desktop's preference and, while the
/// bar is in the title bar, the chrome on every resize, until `stop`. The
/// boot awaits `pending` before it restores the layout, so a terminal fits
/// once, to the final size.
export function startWindowTabBar(): WindowTabBarStart {
  const run = ++generation;
  const current = () => run === generation;
  const override = readWindowTabBarOverride();
  const desktop = isTauriDesktop();
  const os = currentOS();

  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  windowTabBar.on = override === "on";
  windowTabBar.available = false;
  windowTabBar.preferred = false;
  windowTabBar.title = "";

  // Off the desktop there is no title bar to ask about, and on Linux the
  // desktop's title bar commands change nothing, so only a forced bar is
  // drawn there, as a plain top bar.
  if (!desktop || titlebarTabsCommands(os) === null) {
    return { pending: null, stop() {} };
  }

  let engaged = false;
  // Each switch takes a ticket and only the newest one writes, so a quick
  // off and on again ends in the last choice.
  let switches = 0;
  let target: boolean | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const unlisten: Array<() => void> = [];

  function resetChrome(): void {
    windowTabBar.chrome = NO_TITLEBAR_CHROME;
    windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  }

  async function apply(chrome: TitlebarChrome, latest: () => boolean): Promise<void> {
    let next = chrome;
    const height = windowTabBarHeight(next);
    if (height !== windowTabBar.height) {
      next = normalizeTitlebarChrome(await setTitlebarTabs(true, height));
      if (!latest()) return;
    }
    windowTabBar.height = height;
    windowTabBar.chrome = next;
  }

  async function switchTo(wanted: boolean): Promise<void> {
    const ticket = ++switches;
    const latest = () => current() && ticket === switches;
    target = wanted;
    try {
      // Off still tells the desktop: it keeps the overlay across a reload of
      // a page that had it on.
      const chrome = normalizeTitlebarChrome(
        await setTitlebarTabs(wanted, WINDOW_TAB_BAR_MIN_HEIGHT),
      );
      if (!latest()) return;
      if (wanted) await apply(chrome, latest);
      if (!latest()) return;
      engaged = wanted;
      windowTabBar.on = wanted;
      if (!wanted) resetChrome();
    } catch (err) {
      console.warn("[chan] set_titlebar_tabs failed", err);
      if (!latest()) return;
      // The desktop would not take it: no overlay title bar. A forced bar
      // stays as a plain top bar; the preference falls back to none.
      engaged = false;
      target = null;
      resetChrome();
      windowTabBar.on = override === "on";
    }
  }

  function prefer(on: boolean): void {
    windowTabBar.preferred = on;
    if (override !== null || on === target) return;
    void switchTo(on);
  }

  async function engage(): Promise<void> {
    const vocabulary = await hostVocabulary();
    if (!current()) return;
    // An app without every command this host needs is never asked for the
    // title bar, so a Windows window never loses its frame to an app that
    // cannot take the bar's window controls. A forced bar is a plain top bar.
    if (!titlebarTabsSupported(os, vocabulary)) {
      windowTabBar.on = override === "on";
      return;
    }
    windowTabBar.available = true;
    // The subscription is in place before the read, so a change between the
    // two is not lost; an event that lands while the read is in flight is the
    // newer value, so the read yields to it.
    let heard = false;
    const off = await onTauriEvent<{ on?: unknown } | null>(
      TITLEBAR_TABS_PREFERENCE_EVENT,
      (payload) => {
        if (!current()) return;
        heard = true;
        prefer(payload?.on === true);
      },
    );
    const offTitle = await onTauriEvent<{ title?: unknown } | null>(
      TITLEBAR_WINDOW_TITLE_EVENT,
      (payload) => {
        if (!current()) return;
        windowTabBar.title = typeof payload?.title === "string" ? payload.title : "";
      },
    );
    if (!current()) {
      off();
      offTitle();
      return;
    }
    unlisten.push(off, offTitle);
    try {
      const stored = await readTitlebarTabsPreference();
      if (!current()) return;
      if (!heard) windowTabBar.preferred = stored === true;
    } catch (err) {
      // A desktop build without the preference: the tabs stay in the panes.
      console.warn("[chan] titlebar_tabs_preference failed", err);
      if (!current()) return;
    }
    await switchTo(
      windowTabBarWanted({
        override,
        desktop,
        os,
        vocabulary,
        preferred: windowTabBar.preferred,
      }),
    );
  }

  async function refresh(): Promise<void> {
    resizeTimer = null;
    if (!engaged || !current()) return;
    const ticket = switches;
    const latest = () => current() && engaged && ticket === switches;
    try {
      const chrome = normalizeTitlebarChrome(await readTitlebarChrome());
      if (!latest()) return;
      await apply(chrome, latest);
    } catch (err) {
      console.warn("[chan] titlebar_chrome failed", err);
    }
  }

  function onResize(): void {
    if (!engaged) return;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void refresh(), RESIZE_DEBOUNCE_MS);
  }

  window.addEventListener("resize", onResize);
  return {
    pending: engage(),
    stop() {
      if (current()) generation += 1;
      window.removeEventListener("resize", onResize);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = null;
      for (const off of unlisten.splice(0)) off();
    },
  };
}

/// `pending`, bounded by the boot wait.
export async function windowTabBarSettled(
  pending: Promise<void>,
  ms: number = WINDOW_TAB_BAR_BOOT_WAIT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([pending.catch(() => {}), bound]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
