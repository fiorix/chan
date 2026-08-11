/// Graph node palette: the single definition of the default hues plus
/// the reactive custom-override state.
///
/// The eight settable node-kind hues (`--g-doc`, `--g-source`,
/// `--g-binary`, `--g-img`, `--g-folder`, `--g-tag`, `--g-language`,
/// `--g-contact`) are the app's file-kind palette: the file tree, kind
/// chips, inspector refs, JSON tree and empty-pane carousel read the
/// same tokens (see design.md "Canonical semantic palette"). A custom
/// override is therefore applied to the graph surface's subtree
/// (`.graph-tab`) and its portaled tab-menu bubble only, never to
/// `:root`, so the graph alone repaints and every other surface keeps
/// the theme palette. Contact and mention share the one `--g-contact`
/// token (design.md: a mention shares the contact palette by design);
/// outside the graph every consumer reads it with a
/// `var(--g-contact, var(--warn-text))` fallback so the app-wide
/// surfaces resolve to the warning hue exactly as before.
///
/// Default-hex copies that must exist as literal CSS (App.svelte's
/// theme blocks, GraphTuner.svelte's mirror) are asserted equal to
/// `GRAPH_PALETTE_DEFAULTS` by `graphPalette.test.ts`; GraphCanvas's
/// runtime fallbacks import it directly. A retune that lands in one
/// place only goes red.

import type { GraphColorPrefs, GraphPalette } from "../api/types";
import { normalizeHexColor } from "./paneColor";

export type GraphColorKind =
  | "doc"
  | "source"
  | "binary"
  | "img"
  | "folder"
  | "tag"
  | "language"
  | "contact";

export type GraphColorTheme = "dark" | "light";

/// The graph's default node hues, keyed by colour scheme. These are
/// hand-tuned per scheme: the light values are NOT a mechanical
/// function of the dark ones (a hue + saturation shift), which is why
/// a custom palette is stored per scheme rather than derived.
///
/// `contact` mirrors `--warn-text` by design: the token zero-pixel
/// introduction is `--g-contact: var(--warn-text)`, so the hue the
/// Settings swatch shows as the default is the warning hue's literal.
/// graphPalette.test.ts pins that equality, so a `--warn-text` retune
/// goes red here rather than silently detaching the contact default.
export const GRAPH_PALETTE_DEFAULTS: Record<
  GraphColorTheme,
  Record<GraphColorKind, string>
> = {
  dark: {
    doc: "#ff8a3d",
    source: "#4169e1",
    binary: "#5e5e62",
    img: "#b07dff",
    folder: "#8e8e93",
    tag: "#6cd07a",
    language: "#ff4db8",
    contact: "#e3b341",
  },
  light: {
    doc: "#c25a1f",
    source: "#2851c4",
    binary: "#4e4e54",
    img: "#7a4cd8",
    folder: "#6c6c70",
    tag: "#2f9444",
    language: "#c71585",
    contact: "#9a6700",
  },
};

/// Row metadata for the Settings control: label, description, grouping
/// and the CSS custom property each kind writes. This is the deleted
/// HybridGraphConfig legend's layout carried over, with the legend's
/// separate Contact and Mention rows collapsed into one: both kinds
/// share the `--g-contact` token by design (a mention shares the
/// contact palette), so the control exposes them as a single row.
export const GRAPH_COLOR_ROWS: {
  kind: GraphColorKind;
  cssVar: string;
  label: string;
  description: string;
  group: string;
}[] = [
  {
    kind: "doc",
    cssVar: "--g-doc",
    label: "Markdown",
    description: ".md / .txt",
    group: "Files",
  },
  {
    kind: "source",
    cssVar: "--g-source",
    label: "Source code",
    description: ".rs / .py / .ts / config",
    group: "Files",
  },
  {
    kind: "binary",
    cssVar: "--g-binary",
    label: "Binary",
    description: "archives / executables / other",
    group: "Files",
  },
  {
    kind: "img",
    cssVar: "--g-img",
    label: "Media",
    description: "images / PDFs",
    group: "Files",
  },
  {
    kind: "contact",
    cssVar: "--g-contact",
    label: "Contact / mention",
    description: "chan.kind: contact + @@mention (one token)",
    group: "Files",
  },
  {
    kind: "folder",
    cssVar: "--g-folder",
    label: "Directory",
    description: "filesystem dir + workspace root",
    group: "Containers",
  },
  {
    kind: "tag",
    cssVar: "--g-tag",
    label: "Hashtag",
    description: "#tag",
    group: "Graph relations",
  },
  {
    kind: "language",
    cssVar: "--g-language",
    label: "Language",
    description: "tokei language nodes",
    group: "Graph relations",
  },
];

/// Group titles in render order, for the Settings control's sectioning.
export const GRAPH_COLOR_GROUPS = ["Files", "Containers", "Graph relations"];

let mode = $state<"standard" | "custom">("standard");
let overrides = $state<{ dark: GraphPalette; light: GraphPalette }>({
  dark: {},
  light: {},
});

export function graphColorMode(): "standard" | "custom" {
  return mode;
}

/// Mirror the server-sourced `graph_colors` preference into the local
/// override state. Called on boot and on every `config_changed` refresh
/// (`applyServerPreferences`), so a `chan config set` from another
/// window repaints without a reload.
///
/// This is the client-side validation boundary (the load path has no
/// sanitize, same as the terminal precedent): a hand-edited
/// `preferences.toml` carrying a non-hex value drops THAT hue back to
/// the theme default while its neighbours survive, so a malformed
/// colour never reaches a canvas paint call.
export function applyGraphColorPrefs(prefs: GraphColorPrefs | null | undefined): void {
  mode = prefs?.mode === "custom" ? "custom" : "standard";
  overrides = {
    dark: sanitizeGraphPalette(prefs?.dark),
    light: sanitizeGraphPalette(prefs?.light),
  };
}

function sanitizeGraphPalette(palette: GraphPalette | null | undefined): GraphPalette {
  const out: GraphPalette = {};
  if (!palette) return out;
  for (const { kind } of GRAPH_COLOR_ROWS) {
    const hex = normalizeHexColor(palette[kind]);
    if (hex) out[kind] = hex;
  }
  return out;
}

/// The inline custom-property block applying the custom palette for one
/// colour scheme, e.g. `--g-doc:#ff0000;--g-tag:#112233;`. Empty in
/// standard mode or when no hue is overridden, so the surface renders
/// the theme palette untouched. Bound on `.graph-tab` (repaints the
/// canvas, which reads its theme from inside that subtree) and on the
/// portaled tab-menu bubble (the filter dots escape the subtree via
/// `document.body` and need their own application site).
export function graphPaletteStyleFor(theme: GraphColorTheme): string {
  if (mode !== "custom") return "";
  const palette = overrides[theme];
  let style = "";
  for (const { kind, cssVar } of GRAPH_COLOR_ROWS) {
    const hex = palette[kind];
    if (hex) style += `${cssVar}:${hex};`;
  }
  return style;
}
