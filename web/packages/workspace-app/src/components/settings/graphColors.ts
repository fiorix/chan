// The custom graph palette as changes to a preferences record. Every change
// replaces the whole `graph_colors` composite, keeping any dormant palette
// for the other colour scheme. The Graph section and the settings index
// build their writes from the same change.

import type { GraphColorPrefs, GraphPalette } from "../../api/types";
import { sanitizeGraphPalette } from "../../state/graphPalette.svelte";
import type { PreferencesChange } from "./preferenceState.svelte";

/// Drop invalid hues from a stored palette before it enters a PATCH
/// body, with the same per-key rule the paint path applies. The
/// server serves stored hues unvalidated but rejects the whole
/// `graph_colors` object with a 400 on any invalid hex, and
/// preferences.toml is hand-editable, so spreading a raw stored
/// palette lets one bad value silently fail every commit until the
/// TOML is fixed out of band. An emptied palette becomes undefined
/// so the scheme key is omitted, matching the prune of a cleared hue.
function sanitizedStoredPalette(palette: GraphPalette | undefined): GraphPalette | undefined {
  const clean = sanitizeGraphPalette(palette);
  return Object.keys(clean).length === 0 ? undefined : clean;
}

/// Replace the whole composite with `update` applied. Stored palettes are
/// sanitized on the way in, so `update` and the PATCH body only ever see
/// valid hues.
export function graphColorsChange(
  update: (current: GraphColorPrefs) => GraphColorPrefs,
): PreferencesChange {
  return (p) => {
    const current = p.graph_colors;
    const dark = sanitizedStoredPalette(current?.dark);
    const light = sanitizedStoredPalette(current?.light);
    return {
      ...p,
      graph_colors: update({
        mode: current?.mode ?? "standard",
        ...(dark ? { dark } : {}),
        ...(light ? { light } : {}),
      }),
    };
  };
}

/// Switch the custom palette on or off. Off keeps the stored palettes
/// dormant, so a later activation restores them unchanged.
export function customGraphColorsChange(on: boolean): PreferencesChange {
  return graphColorsChange((c) => ({ ...c, mode: on ? "custom" : "standard" }));
}
