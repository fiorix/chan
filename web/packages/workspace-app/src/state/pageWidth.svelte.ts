// Page-width cap as a ratio of the current window width.
//
// Caps the centered editor content (.cm-content) on
// wide screens so a fullscreen window doesn't stretch lines the
// full viewport. The cap is stored as a single ratio in (0, 1]:
//   1.0  -> no cap (content fills the container minus padding)
//   r<1  -> cap = round(window.innerWidth * r)
//
// Storing a ratio (not absolute pixels) is what makes the cap
// "relative" in the user-facing sense:
//   - resizing the browser window: the cap follows innerWidth, so
//     the editor stays at the same % of the window
//   - browser zoom (cmd +/-): zoom rescales CSS pixels, which
//     changes innerWidth in CSS units; the cap rescales with it
//     instead of getting wedged at a now-meaningless pixel value
//
// The cap (and the overlay-maximize toggle below) persist in the
// per-library server preferences, so they travel with the library and
// stay consistent across clients. Writes go through PATCH /api/config
// (debounced for the drag-driven width slider); reads hydrate from the
// preferences block on boot and on every `config_changed` event, which
// also syncs the value live across open windows.

import { api } from "../api/client";

const CSS_VAR = "--chan-page-max-width";

/// Slider bounds in percent. 100 % is the "no cap" sentinel; below
/// 25 % the editor would be unusably narrow on any normal window,
/// so we clamp there.
export const PAGE_WIDTH_MIN_PCT = 25;
export const PAGE_WIDTH_MAX_PCT = 100;
export const PAGE_WIDTH_STEP_PCT = 5;

/// Floor on the resolved pixel cap. Even at the smallest ratio on a
/// tiny window we don't want the cap to collapse to a sliver.
const MIN_RESOLVED_PX = 240;

/// Default ratio for first-time users (no stored preference yet).
/// 80% leaves a clear off-page band on each side, matching the
/// document-style page look the rest of the editor was already
/// hinting at via --page-shade. A stored per-library ratio overrides
/// this on hydrate.
export const DEFAULT_RATIO = 0.8;

export const pageWidth = $state<{ ratio: number }>({ ratio: DEFAULT_RATIO });

/// Global overlay-maximize toggle. When on, every OverlayShell
/// widens its panel from `min(1200px, calc(100vw - 48px))` to
/// `calc(100vw - 88px)` so the side gap matches the top safe-area
/// + 44px chrome buffer. Lives next to the page-width state because
/// both knobs persist in the same per-library preferences block and
/// the menu items that toggle them sit in the same hamburger surfaces.
export const overlayMaximized = $state<{ on: boolean }>({ on: false });

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_RATIO;
  const lo = PAGE_WIDTH_MIN_PCT / 100;
  const hi = PAGE_WIDTH_MAX_PCT / 100;
  return Math.max(lo, Math.min(hi, r));
}

/// The width slider fires on every drag tick, so the cap applies to
/// the DOM immediately but the server write is debounced: only the
/// settled value is PATCHed, avoiding a flood of /api/config writes
/// mid-drag.
const PERSIST_DEBOUNCE_MS = 400;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistRatio(): void {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    api.setPageWidthRatio(pageWidth.ratio).catch((e) => {
      console.warn("chan: failed to persist page-width", e);
    });
  }, PERSIST_DEBOUNCE_MS);
}

function applyToDom(r: number): void {
  const root = document.documentElement;
  if (r >= 1) {
    root.style.removeProperty(CSS_VAR);
    root.classList.remove("chan-page-capped");
    return;
  }
  const px = Math.max(MIN_RESOLVED_PX, Math.round(window.innerWidth * r));
  root.style.setProperty(CSS_VAR, `${px}px`);
  root.classList.add("chan-page-capped");
}

/// First-paint apply. Runs synchronously before any editor mounts so
/// the initial render is already capped to the default ratio. The
/// per-library stored value arrives a moment later over the bootstrap
/// `/api/workspace` fetch and lands through `hydratePageWidthFromPrefs`.
export function applyInitialPageWidth(): void {
  if (typeof window === "undefined") return;
  applyToDom(pageWidth.ratio);
}

/// Hydrate the cap + overlay-maximize toggle from the per-library
/// server preferences. Called from `applyServerPreferences` on boot
/// (once `workspace.info` is set) and on every `config_changed` WS
/// event, so a change in one window propagates live to the others. The
/// server stores the ratio verbatim; clamp to the slider bounds on
/// read. Absent fields fall back to the defaults.
export function hydratePageWidthFromPrefs(
  ratio: number | undefined,
  overlay: boolean | undefined,
): void {
  if (typeof window === "undefined") return;
  const next = clampRatio(ratio ?? DEFAULT_RATIO);
  if (next !== pageWidth.ratio) {
    pageWidth.ratio = next;
    applyToDom(next);
  }
  const on = overlay ?? false;
  if (on !== overlayMaximized.on) {
    overlayMaximized.on = on;
  }
}

/// User-driven toggle. Single click, so persist directly (no debounce);
/// the optimistic local flip keeps the UI instant.
export function setOverlayMaximized(on: boolean): void {
  overlayMaximized.on = on;
  api.setOverlayMaximizedPref(on).catch((e) => {
    console.warn("chan: failed to persist overlay-maximize", e);
  });
}

/// User-driven update. Pass a ratio in (0, 1]; 1 means unbounded.
/// Applies the cap immediately; the server write is debounced.
export function setPageWidth(r: number): void {
  const next = clampRatio(r);
  pageWidth.ratio = next;
  applyToDom(next);
  schedulePersistRatio();
}

/// Per-element apply. Each Pane.svelte instance subscribes to its
/// own .editor-wrap width via ResizeObserver and calls this; the
/// resulting cap is pane-relative instead of window-relative, so
/// splitting one pane into two halves correctly halves the cap.
/// Window resize / browser zoom also flow through the same
/// observer because the pane shrinks with the window.
export function applyPageWidthToElement(
  el: HTMLElement,
  containerWidth: number,
  r: number,
): void {
  if (r >= 1 || containerWidth <= 0) {
    el.style.removeProperty(CSS_VAR);
    return;
  }
  const px = Math.max(MIN_RESOLVED_PX, Math.round(containerWidth * r));
  el.style.setProperty(CSS_VAR, `${px}px`);
}

/// Re-apply on viewport changes (resize, browser zoom). Cross-window
/// sync of the stored ratio rides the `config_changed` WS event
/// (`hydratePageWidthFromPrefs`), so there is no `storage` listener.
export function watchPageWidth(): () => void {
  if (typeof window === "undefined") return () => {};

  let raf: number | null = null;
  const reapply = () => {
    raf = null;
    applyToDom(pageWidth.ratio);
  };
  const onResize = () => {
    if (raf != null) return;
    raf = requestAnimationFrame(reapply);
  };
  window.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
    if (raf != null) cancelAnimationFrame(raf);
  };
}
