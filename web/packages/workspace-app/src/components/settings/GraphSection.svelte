<script lang="ts">
  // Graph settings: the node palette override, per colour scheme, and
  // the graph surface's Hybrid body-theme override. Every commit
  // replaces the whole `graph_colors` composite with one hue changed,
  // keeping any dormant palette for the other scheme (see graphColors.ts).
  // Each field takes its words from the settings index.

  import type { GraphColorPrefs, GraphPalette, Preferences } from "../../api/types";
  import { ui } from "../../state/store.svelte";
  import {
    GRAPH_COLOR_GROUPS,
    GRAPH_COLOR_ROWS,
    GRAPH_PALETTE_DEFAULTS,
    type GraphColorKind,
    type GraphColorTheme,
  } from "../../state/graphPalette.svelte";
  import { commitSetting, type CommitFn, type CommitOptions, type SaveStatus } from "./commit";
  import { graphColorsChange } from "./graphColors";
  import { settingEntry, toggledIn } from "./settingsIndex";
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

  const CUSTOM_COLORS = settingEntry("graph.customColors");
  const COLOR_ROWS = GRAPH_COLOR_ROWS.map((row) => ({
    ...row,
    entry: settingEntry(`graph.colors.${row.kind}`),
  }));

  const graphColorsOn = $derived(toggledIn(CUSTOM_COLORS, prefs));
  let graphEditTheme = $state<GraphColorTheme>(ui.theme);

  function commitGraphColors(
    update: (current: GraphColorPrefs) => GraphColorPrefs,
    options?: CommitOptions,
  ): Promise<SaveStatus> {
    return commit(graphColorsChange(update), undefined, options);
  }

  /// Write or clear one hue in the edited scheme's palette. `hex` null
  /// clears the override (the hue falls back to the theme palette).
  function writeGraphColor(
    kind: GraphColorKind,
    hex: string | null,
  ): Promise<SaveStatus> {
    return commitGraphColors((c) => {
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
    }, { ownStatus: true });
  }

  /// Write or clear one hue in the edited scheme's palette (ColorField
  /// hands over a normalized hex, or null when the row was cleared or
  /// holds the default). Skips no-op writes.
  /// The row reports for itself, the same as the terminal palette: every
  /// row writes one preference, so the preference cannot name the row.
  function commitGraphColor(
    kind: GraphColorKind,
    hex: string | null,
  ): Promise<SaveStatus> | undefined {
    const existing = prefs.graph_colors?.[graphEditTheme]?.[kind];
    if (hex === null && existing === undefined) return undefined;
    if (hex !== null && hex === existing) return undefined;
    return writeGraphColor(kind, hex);
  }

  function resetGraphPalette(): void {
    commitGraphColors((c) =>
      graphEditTheme === "dark" ? { ...c, dark: undefined } : { ...c, light: undefined },
    );
  }
</script>

<SettingField
  setting={CUSTOM_COLORS}
  pref="graph_colors"
  hint="Override graph node hues, per colour scheme. Applies to the graph surface only; every other surface keeps the theme palette. Clear a field to fall back to the default hue."
>
  <PillToggle
    label={CUSTOM_COLORS.caption}
    checked={graphColorsOn}
    ontoggle={(on) => commitSetting(commit, CUSTOM_COLORS, on)}
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
      {#each COLOR_ROWS.filter((row) => row.group === group) as row (row.kind)}
        {@const committed = prefs.graph_colors?.[graphEditTheme]?.[row.kind]}
        <ColorField
          id={`graph-colour-${row.kind}`}
          setting={row.entry.id}
          label={row.entry.caption}
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
