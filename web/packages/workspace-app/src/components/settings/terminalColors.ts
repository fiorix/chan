// The custom terminal colour block as changes to a preferences record. The
// block is atomic: the toggle swaps the whole `terminal_colors` composite,
// and each colour or contrast change replaces the payload with one field
// changed. The Terminal section and the settings index build their writes
// from the same changes.

import type { Preferences, TerminalCustomColors } from "../../api/types";
import { normalizeHexColor, readStandardTerminalColors } from "../../state/paneColor";
import type { PreferencesChange } from "./preferenceState.svelte";

function standardTerminalTheme(current: Preferences): "dark" | "light" {
  const surface = current.hybrid_surface_themes?.terminal;
  if (surface) return surface;
  if (current.theme === "dark" || current.theme === "light") return current.theme;
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/// The colours a terminal of this page wears in standard mode, read from
/// the page's own theme tokens.
export function snapshotStandardTerminalColors(current: Preferences): TerminalCustomColors {
  const theme = standardTerminalTheme(current);
  const root = document.documentElement;
  let source: Element = root;
  let probe: HTMLDivElement | null = null;
  if (root.dataset.theme !== theme) {
    probe = document.createElement("div");
    probe.dataset.theme = theme;
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;";
    document.body.appendChild(probe);
    source = probe;
  }
  const colors = readStandardTerminalColors(source);
  probe?.remove();
  return { ...colors, contrast: "auto" };
}

/// The stored palette in the form the config route accepts. The route
/// refuses the whole palette for one hex it cannot parse (it wants the
/// leading `#`), and a hand edit of the file can leave such a hex, so a
/// write that copied the palette as stored would fail. Each hex goes in
/// its normalized form, and one that does not parse takes the standard
/// colour in its place.
function acceptedCustomColors(
  custom: TerminalCustomColors,
  current: Preferences,
): TerminalCustomColors {
  const background = normalizeHexColor(custom.background);
  const foreground = normalizeHexColor(custom.foreground);
  const cursor = normalizeHexColor(custom.cursor);
  if (background && foreground && cursor) return { ...custom, background, foreground, cursor };
  const standard = snapshotStandardTerminalColors(current);
  return {
    ...custom,
    background: background ?? standard.background,
    foreground: foreground ?? standard.foreground,
    cursor: cursor ?? standard.cursor,
  };
}

/// Switch the custom colours on or off. On keeps a stored palette and
/// otherwise starts from the page's standard colours; off keeps the stored
/// palette dormant.
export function customTerminalColorsChange(on: boolean): PreferencesChange {
  // The page's standard colours are read once per switch: a write runs the
  // change twice, so a read inside it would run twice too.
  let standard: TerminalCustomColors | null = null;
  return (p) => {
    const stored = p.terminal_colors?.custom;
    return {
      ...p,
      terminal_colors: on
        ? {
            mode: "custom",
            custom: stored
              ? acceptedCustomColors(stored, p)
              : (standard ??= snapshotStandardTerminalColors(p)),
          }
        : {
            mode: "standard",
            ...(stored ? { custom: acceptedCustomColors(stored, p) } : {}),
          },
    };
  };
}

/// Replace the custom payload with `update` applied. Nothing changes while
/// no custom payload is stored.
export function customTerminalColorsUpdate(
  update: (custom: TerminalCustomColors) => TerminalCustomColors,
): PreferencesChange {
  return (p) => {
    const current = p.terminal_colors?.custom;
    if (!current) return p;
    return {
      ...p,
      terminal_colors: { mode: "custom", custom: update(acceptedCustomColors(current, p)) },
    };
  };
}

/// Replace the custom payload with the page's standard colours.
export function resetTerminalColorsChange(): PreferencesChange {
  return (p) => ({
    ...p,
    terminal_colors: { mode: "custom", custom: snapshotStandardTerminalColors(p) },
  });
}
