<script lang="ts">
  // Appearance settings: the editor-prefs slice that skins the app and
  // editor. App theme reuses `setThemeChoice` so the chrome re-skins the
  // instant it is picked; the rest write single fields through the
  // parent's commit.

  import type {
    BubbleOverlayMode,
    EditorTheme,
    HybridSurfaceKind,
    HybridSurfaceThemes,
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
  } from "../../state/store.svelte";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";
  import PillToggle from "./PillToggle.svelte";
  import {
    normalizeHexColor,
    readStandardTerminalColors,
  } from "../../state/paneColor";

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

  function nextSurfaceThemes(
    current: HybridSurfaceThemes | undefined,
    kind: HybridSurfaceKind,
    choice: string,
  ): HybridSurfaceThemes {
    const next: HybridSurfaceThemes = { ...(current ?? {}) };
    if (choice === "light" || choice === "dark") next[kind] = choice;
    else delete next[kind];
    return next;
  }

  // Reuse the store setters (they apply the skin live and persist through
  // the same serial config chain), mirroring how the app theme reuses
  // setThemeChoice; the optimistic buffer slice keeps the control in sync.
  function selectSurfaceTheme(kind: HybridSurfaceKind, choice: string): void {
    commit(
      (p) => ({
        ...p,
        hybrid_surface_themes: nextSurfaceThemes(
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
  let terminalColorDrafts = $state<Record<TerminalColorField, string>>({
    background: "#1c1c1e",
    foreground: "#ebebf0",
    cursor: "#58a6ff",
  });
  let terminalColorErrors = $state<Partial<Record<TerminalColorField, string>>>({});
  let lastTerminalColorState = "";
  $effect(() => {
    const payload = prefs.terminal_colors?.custom;
    const state = `${prefs.terminal_colors?.mode ?? "standard"}:${JSON.stringify(payload ?? null)}`;
    if (!payload || state === lastTerminalColorState) return;
    lastTerminalColorState = state;
    terminalColorDrafts = {
      background: payload.background,
      foreground: payload.foreground,
      cursor: payload.cursor,
    };
    terminalColorErrors = {};
  });

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

  function updateTerminalColorDraft(field: TerminalColorField, value: string): void {
    terminalColorDrafts = { ...terminalColorDrafts, [field]: value };
  }

  function commitTerminalColor(field: TerminalColorField, value: string): void {
    const normalized = normalizeHexColor(value);
    if (!normalized) {
      terminalColorErrors = {
        ...terminalColorErrors,
        [field]: "Enter #rgb or #rrggbb.",
      };
      return;
    }
    updateTerminalColorDraft(field, normalized);
    terminalColorErrors = { ...terminalColorErrors, [field]: undefined };
    commitCustomTerminalColors((custom) => ({ ...custom, [field]: normalized }));
  }

  function onTerminalColorKeydown(
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
    field: TerminalColorField,
  ): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitTerminalColor(field, event.currentTarget.value);
    event.currentTarget.blur();
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
      <div class="terminal-colour-row">
        <label for={`terminal-colour-${row.key}`}>{row.label}</label>
        <input
          type="color"
          value={customTerminalColors[row.key]}
          aria-label={`${row.label} colour swatch`}
          oninput={(event) => commitTerminalColor(row.key, event.currentTarget.value)}
        />
        <input
          id={`terminal-colour-${row.key}`}
          type="text"
          value={terminalColorDrafts[row.key]}
          aria-invalid={terminalColorErrors[row.key] ? "true" : undefined}
          oninput={(event) => updateTerminalColorDraft(row.key, event.currentTarget.value)}
          onblur={(event) => commitTerminalColor(row.key, event.currentTarget.value)}
          onkeydown={(event) => onTerminalColorKeydown(event, row.key)}
        />
        {#if terminalColorErrors[row.key]}
          <span class="colour-error" role="alert">{terminalColorErrors[row.key]}</span>
        {/if}
      </div>
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

<style>
  .terminal-colours {
    display: grid;
    gap: 10px;
    padding: 12px 0 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .terminal-colour-row,
  .terminal-contrast-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .terminal-colour-row > label,
  .terminal-contrast-row > span {
    width: 8em;
    color: var(--text);
    font-size: 13px;
  }
  .terminal-colour-row input[type="color"] {
    width: 34px;
    height: 30px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
  }
  .terminal-colour-row input[type="text"] {
    width: 8em;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--chan-editor-code-family, monospace);
  }
  .terminal-colour-row input[aria-invalid="true"] {
    border-color: var(--danger, #ef4444);
  }
  .colour-error {
    color: var(--danger, #ef4444);
    font-size: 12px;
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
