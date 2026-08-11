<script lang="ts">
  // Appearance settings: the editor-prefs slice that skins the app and
  // editor. App theme reuses `setThemeChoice` so the chrome re-skins the
  // instant it is picked; the rest write single fields through the
  // parent's commit.

  import type {
    BubbleOverlayMode,
    EditorTheme,
    GraphColorPrefs,
    GraphPalette,
    HybridSurfaceKind,
    LineSpacing,
    Preferences,
    SurfaceThemeChoice,
    TerminalContrast,
    TerminalCustomColors,
    ThemeChoice,
  } from "../../api/types";
  import {
    clearHybridSurfaceTheme,
    setHybridSurfaceTheme,
    setThemeChoice,
    ui,
    withHybridSurfaceTheme,
  } from "../../state/store.svelte";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";
  import PillToggle from "./PillToggle.svelte";
  import ColorField from "./ColorField.svelte";
  import { readStandardTerminalColors } from "../../state/paneColor";
  import {
    GRAPH_COLOR_GROUPS,
    GRAPH_COLOR_ROWS,
    GRAPH_PALETTE_DEFAULTS,
    type GraphColorKind,
    type GraphColorTheme,
  } from "../../state/graphPalette.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const THEMES = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  const EDITOR_THEMES = [
    { value: "github", label: "GitHub" },
    { value: "google_docs", label: "Google Docs" },
    { value: "word", label: "Microsoft Word" },
  ] as const;
  const SPACING = [
    { value: "standard", label: "Standard" },
    { value: "compact", label: "Compact" },
  ] as const;
  const BUBBLES = [
    { value: "stack", label: "Inline" },
    { value: "tray", label: "Tray" },
  ] as const;
  const TERMINAL_CONTRAST = [
    { value: "auto", label: "Auto" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ] as const;
  const TERMINAL_COLOR_ROWS = [
    { key: "background", label: "Background" },
    { key: "foreground", label: "Foreground" },
    { key: "cursor", label: "Cursor" },
  ] as const;
  type TerminalColorField = (typeof TERMINAL_COLOR_ROWS)[number]["key"];

  // Per-Hybrid body-theme overrides. Each surface can pin its body to
  // Light or Dark independently of the app theme, or Inherit it. Inherit
  // drops the key so the surface follows the app theme again.
  const SURFACE_THEME_OPTIONS = [
    { value: "inherit", label: "Inherit" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  const SURFACE_ROWS: { kind: HybridSurfaceKind; label: string }[] = [
    { kind: "editor", label: "Editor body theme" },
    { kind: "terminal", label: "Terminal body theme" },
    { kind: "browser", label: "File browser body theme" },
    { kind: "graph", label: "Graph body theme" },
    { kind: "dashboard", label: "Dashboard body theme" },
  ];

  // Reuse the store setters (they apply the skin live and persist through
  // the same serial config chain), mirroring how the app theme reuses
  // setThemeChoice; the optimistic buffer slice keeps the control in sync.
  // Both sides merge-versus-delete through the store's
  // withHybridSurfaceTheme, so the buffer and the persist agree.
  function selectSurfaceTheme(kind: HybridSurfaceKind, choice: string): void {
    commit(
      (p) => ({
        ...p,
        hybrid_surface_themes: withHybridSurfaceTheme(
          p.hybrid_surface_themes,
          kind,
          choice,
        ),
      }),
      () => {
        if (choice === "light" || choice === "dark") {
          setHybridSurfaceTheme(kind, choice as SurfaceThemeChoice);
        } else {
          clearHybridSurfaceTheme(kind);
        }
        return Promise.resolve();
      },
    );
  }

  const customTerminalColorsOn = $derived(prefs.terminal_colors?.mode === "custom");
  const customTerminalColors = $derived(prefs.terminal_colors?.custom);

  function standardTerminalTheme(current: Preferences): "dark" | "light" {
    const surface = current.hybrid_surface_themes?.terminal;
    if (surface) return surface;
    if (current.theme === "dark" || current.theme === "light") return current.theme;
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  function snapshotStandardTerminalColors(current: Preferences): TerminalCustomColors {
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

  function toggleCustomTerminalColors(on: boolean): void {
    commit((p) => ({
      ...p,
      terminal_colors: on
        ? {
            mode: "custom",
            custom: p.terminal_colors?.custom ?? snapshotStandardTerminalColors(p),
          }
        : {
            mode: "standard",
            ...(p.terminal_colors?.custom ? { custom: p.terminal_colors.custom } : {}),
          },
    }));
  }

  function commitCustomTerminalColors(
    update: (custom: TerminalCustomColors) => TerminalCustomColors,
  ): void {
    commit((p) => {
      const current = p.terminal_colors?.custom;
      if (!current) return p;
      return {
        ...p,
        terminal_colors: { mode: "custom", custom: update({ ...current }) },
      };
    });
  }

  /// Write one normalized hex (from ColorField) into the custom payload.
  function commitTerminalColor(field: TerminalColorField, hex: string): void {
    commitCustomTerminalColors((custom) => ({ ...custom, [field]: hex }));
  }

  function setTerminalContrast(contrast: string): void {
    commitCustomTerminalColors((custom) => ({
      ...custom,
      contrast: contrast as TerminalContrast,
    }));
  }

  function resetTerminalColors(): void {
    commit((p) => ({
      ...p,
      terminal_colors: {
        mode: "custom",
        custom: snapshotStandardTerminalColors(p),
      },
    }));
  }

  // ---- custom graph colours ---------------------------------------------
  // One row per node-kind hue, per colour scheme; the row grouping and
  // descriptions carry the deleted HybridGraphConfig legend's layout
  // (GRAPH_COLOR_ROWS). Every commit replaces the whole `graph_colors`
  // composite with one hue changed, the same write shape as the
  // terminal colour control above.
  const GRAPH_EDIT_MODES = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ] as const;

  const graphColorsOn = $derived(prefs.graph_colors?.mode === "custom");
  let graphEditTheme = $state<GraphColorTheme>(ui.theme);

  /// Replace the whole composite with `update` applied, keeping any
  /// dormant palette for the other scheme.
  function commitGraphColors(update: (current: GraphColorPrefs) => GraphColorPrefs): void {
    commit((p) => {
      const current = p.graph_colors;
      return {
        ...p,
        graph_colors: update({
          mode: current?.mode ?? "standard",
          ...(current?.dark ? { dark: current.dark } : {}),
          ...(current?.light ? { light: current.light } : {}),
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

<SettingField label="Theme" hint="App-wide colour theme. System follows your OS setting.">
  <PillRadio
    name="settings-theme"
    ariaLabel="App theme"
    value={prefs.theme}
    options={THEMES}
    onselect={(v) =>
      commit(
        (p) => ({ ...p, theme: v as ThemeChoice }),
        () => {
          setThemeChoice(v as ThemeChoice);
          return Promise.resolve();
        },
      )}
  />
</SettingField>

<SettingField
  label="Editor theme"
  hint="Typography and chrome of the markdown editor only."
>
  <PillRadio
    name="settings-editor-theme"
    ariaLabel="Editor theme"
    value={prefs.editor_theme}
    options={EDITOR_THEMES}
    onselect={(v) => commit((p) => ({ ...p, editor_theme: v as EditorTheme }))}
  />
</SettingField>

<SettingField
  label="Line spacing"
  hint="Reading density for paragraphs and lists in the editor."
>
  <PillRadio
    name="settings-line-spacing"
    ariaLabel="Line spacing"
    value={prefs.line_spacing}
    options={SPACING}
    onselect={(v) => commit((p) => ({ ...p, line_spacing: v as LineSpacing }))}
  />
</SettingField>

<SettingField
  label="Watcher bubbles"
  hint="Show filesystem-watch notices inline, or collapse them to a count tray until expanded."
>
  <PillRadio
    name="settings-bubbles"
    ariaLabel="Watcher bubbles"
    value={prefs.bubble_overlay_mode}
    options={BUBBLES}
    onselect={(v) =>
      commit((p) => ({ ...p, bubble_overlay_mode: v as BubbleOverlayMode }))}
  />
</SettingField>

{#each SURFACE_ROWS as row, i (row.kind)}
  <SettingField
    label={row.label}
    hint={i === 0
      ? "Pin a Hybrid surface's body to Light or Dark independently of the app theme, or Inherit it."
      : undefined}
  >
    <PillRadio
      name={`settings-surface-theme-${row.kind}`}
      ariaLabel={`${row.label} override`}
      value={prefs.hybrid_surface_themes?.[row.kind] ?? "inherit"}
      options={SURFACE_THEME_OPTIONS}
      onselect={(v) => selectSurfaceTheme(row.kind, v)}
    />
  </SettingField>
{/each}

<SettingField
  label="Custom terminal colours"
  hint="Override terminal background, foreground, and cursor colours. The terminal's standard Inherit, Light, or Dark choice remains underneath."
>
  <PillToggle
    label="Custom terminal colours"
    checked={customTerminalColorsOn}
    ontoggle={toggleCustomTerminalColors}
  />
</SettingField>

{#if customTerminalColorsOn && customTerminalColors}
  <div class="terminal-colours">
    {#each TERMINAL_COLOR_ROWS as row (row.key)}
      <ColorField
        id={`terminal-colour-${row.key}`}
        label={row.label}
        value={customTerminalColors[row.key]}
        oncommit={(hex) => hex !== null && commitTerminalColor(row.key, hex)}
      />
    {/each}
    <div class="terminal-contrast-row">
      <span>ANSI contrast</span>
      <PillRadio
        name="settings-terminal-contrast"
        ariaLabel="Terminal ANSI contrast"
        value={customTerminalColors.contrast}
        options={TERMINAL_CONTRAST}
        onselect={setTerminalContrast}
      />
    </div>
    <button type="button" class="reset-terminal-colours" onclick={resetTerminalColors}>
      Reset to current standard
    </button>
  </div>
{/if}

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
  <div class="terminal-colours">
    <div class="terminal-contrast-row">
      <span>Editing palette</span>
      <PillRadio
        name="settings-graph-palette-theme"
        ariaLabel="Graph palette colour scheme"
        value={graphEditTheme}
        options={GRAPH_EDIT_MODES}
        onselect={(v) => (graphEditTheme = v as GraphColorTheme)}
      />
    </div>
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
    <button type="button" class="reset-terminal-colours" onclick={resetGraphPalette}>
      Reset {graphEditTheme} palette to theme defaults
    </button>
  </div>
{/if}

<style>
  .terminal-colours {
    display: grid;
    gap: 10px;
    padding: 12px 0 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .terminal-contrast-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .terminal-contrast-row > span {
    width: 8em;
    color: var(--text);
    font-size: 13px;
  }
  .graph-palette-group {
    margin-top: 4px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .reset-terminal-colours {
    justify-self: start;
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .reset-terminal-colours:hover {
    border-color: var(--btn-hover);
  }
</style>
