<script lang="ts">
  // Graph settings: the node palette override, per colour scheme, and
  // the graph surface's Hybrid body-theme override. Every commit
  // replaces the whole `graph_colors` composite with one hue changed,
  // keeping any dormant palette for the other scheme.

  import type { GraphColorPrefs, GraphPalette, Preferences } from "../../api/types";
  import { ui } from "../../state/store.svelte";
  import {
    GRAPH_COLOR_GROUPS,
    GRAPH_COLOR_ROWS,
    GRAPH_PALETTE_DEFAULTS,
    sanitizeGraphPalette,
    type GraphColorKind,
    type GraphColorTheme,
  } from "../../state/graphPalette.svelte";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import PillRadio from "./PillRadio.svelte";
  import ColorField from "./ColorField.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const GRAPH_EDIT_MODES = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ] as const;

  const graphColorsOn = $derived(prefs.graph_colors?.mode === "custom");
  let graphEditTheme = $state<GraphColorTheme>(ui.theme);

  /// Drop invalid hues from a stored palette before it enters a PATCH
  /// body, with the same per-key rule the paint path applies. The
  /// server serves stored hues unvalidated but rejects the whole
  /// `graph_colors` object with a 400 on any invalid hex, and
  /// preferences.toml is hand-editable, so spreading a raw stored
  /// palette lets one bad value silently fail every commit until the
  /// TOML is fixed out of band. An emptied palette becomes undefined
  /// so the scheme key is omitted, matching writeGraphColor's prune.
  function sanitizedStoredPalette(
    palette: GraphPalette | undefined,
  ): GraphPalette | undefined {
    const clean = sanitizeGraphPalette(palette);
    return Object.keys(clean).length === 0 ? undefined : clean;
  }

  /// Replace the whole composite with `update` applied, keeping any
  /// dormant palette for the other scheme. Stored palettes are
  /// sanitized on the way in, so `update` and the PATCH body only ever
  /// see valid hues.
  function commitGraphColors(update: (current: GraphColorPrefs) => GraphColorPrefs): void {
    commit((p) => {
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
    });
  }

  function toggleCustomGraphColors(on: boolean): void {
    // Off keeps the stored palettes dormant (terminal parity), so a
    // later activation restores them unchanged.
    commitGraphColors((c) => ({ ...c, mode: on ? "custom" : "standard" }));
  }

  /// Write or clear one hue in the edited scheme's palette. `hex` null
  /// clears the override (the hue falls back to the theme palette).
  function writeGraphColor(kind: GraphColorKind, hex: string | null): void {
    commitGraphColors((c) => {
      const palette: GraphPalette = { ...(c[graphEditTheme] ?? {}) };
      if (hex === null) delete palette[kind];
      else palette[kind] = hex;
      // Prune an emptied palette rather than storing `"dark": {}`.
      const pruned = Object.keys(palette).length === 0 ? undefined : palette;
      // Explicit per-scheme branches: a computed `[graphEditTheme]` key
      // widens the literal to a string index and loses GraphColorPrefs.
      return graphEditTheme === "dark"
        ? { ...c, mode: "custom", dark: pruned }
        : { ...c, mode: "custom", light: pruned };
    });
  }

  /// Write or clear one hue in the edited scheme's palette (ColorField
  /// hands over a normalized hex, or null when the row was cleared or
  /// holds the default). Skips no-op writes.
  function commitGraphColor(kind: GraphColorKind, hex: string | null): void {
    const existing = prefs.graph_colors?.[graphEditTheme]?.[kind];
    if (hex === null && existing === undefined) return;
    if (hex !== null && hex === existing) return;
    writeGraphColor(kind, hex);
  }

  function resetGraphPalette(): void {
    commitGraphColors((c) =>
      graphEditTheme === "dark" ? { ...c, dark: undefined } : { ...c, light: undefined },
    );
  }
</script>

<SettingField
  label="Custom graph colours"
  hint="Override graph node hues, per colour scheme. Applies to the graph surface only; every other surface keeps the theme palette. Clear a field to fall back to the default hue."
>
  <PillToggle
    label="Custom graph colours"
    checked={graphColorsOn}
    ontoggle={toggleCustomGraphColors}
  />
</SettingField>

{#if graphColorsOn}
  <SettingField label="Editing palette">
    <PillRadio
      name="settings-graph-palette-theme"
      ariaLabel="Graph palette colour scheme"
      value={graphEditTheme}
      options={GRAPH_EDIT_MODES}
      onselect={(v) => (graphEditTheme = v as GraphColorTheme)}
    />
  </SettingField>
  <div class="graph-colours">
    {#each GRAPH_COLOR_GROUPS as group (group)}
      <div class="graph-palette-group">{group}</div>
      {#each GRAPH_COLOR_ROWS.filter((row) => row.group === group) as row (row.kind)}
        {@const committed = prefs.graph_colors?.[graphEditTheme]?.[row.kind]}
        <ColorField
          id={`graph-colour-${row.kind}`}
          label={row.label}
          description={row.description}
          value={committed ?? GRAPH_PALETTE_DEFAULTS[graphEditTheme][row.kind]}
          defaultHex={GRAPH_PALETTE_DEFAULTS[graphEditTheme][row.kind]}
          oncommit={(hex) => commitGraphColor(row.kind, hex)}
        />
      {/each}
    {/each}
    <button type="button" class="reset-graph-colours" onclick={resetGraphPalette}>
      Reset {graphEditTheme} palette to theme defaults
    </button>
  </div>
{/if}

<SurfaceThemeField kind="graph" {prefs} {commit} />

<style>
  .graph-colours {
    display: grid;
    gap: 10px;
    padding: 12px 0 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .graph-palette-group {
    margin-top: 4px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .reset-graph-colours {
    justify-self: start;
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .reset-graph-colours:hover {
    border-color: var(--btn-hover);
  }
</style>
