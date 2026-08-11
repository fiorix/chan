<script lang="ts">
  // Editor settings: everything that skins or shapes the editor
  // surface - its theme, density, font size, page width, date format
  // and save behaviour, plus its Hybrid body-theme override.

  import type { EditorTheme, LineSpacing, Preferences } from "../../api/types";
  import type { CommitFn } from "./commit";
  import { DATE_FORMATS } from "../../editor/dateFormats";
  import {
    PAGE_WIDTH_MAX_PCT,
    PAGE_WIDTH_MIN_PCT,
    PAGE_WIDTH_STEP_PCT,
  } from "../../state/pageWidth.svelte";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import PillRadio from "./PillRadio.svelte";
  import SliderField from "./SliderField.svelte";
  import NumberField from "./NumberField.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";
  import {
    applyEditorFontSize,
    EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
    resolvedEditorThemeBodySizePx,
  } from "../../state/editorTheme";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const EDITOR_THEMES = [
    { value: "github", label: "GitHub" },
    { value: "google_docs", label: "Google Docs" },
    { value: "word", label: "Microsoft Word" },
  ] as const;
  const SPACING = [
    { value: "standard", label: "Standard" },
    { value: "compact", label: "Compact" },
  ] as const;

  function ratioToPct(r: number | undefined): number {
    const clamped = Math.min(1, Math.max(0.25, r ?? 0.8));
    return Math.round(clamped * 100);
  }

  // The placeholder previews the active theme's body size, so it
  // follows a theme switch even though the field stays empty.
  let themeSizePlaceholder = $state("16 px");
  $effect(() => {
    void prefs.editor_theme;
    const themeSize = Math.round(resolvedEditorThemeBodySizePx() * 100) / 100;
    themeSizePlaceholder = `${themeSize} px`;
  });

  /// NumberField commits a clamped size, or null when the field was
  /// cleared ("use the theme"). The side effect applies the size live;
  /// the commit persists it, and is skipped when nothing changed.
  function commitFontSize(next: number | null): void {
    applyEditorFontSize(next);
    if ((prefs.editor_font_size ?? null) === next) return;
    commit((p) => ({ ...p, editor_font_size: next }));
  }
</script>

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
  label="Editor font size"
  hint="Absolute body size for WYSIWYG, source, document, and slide surfaces. Leave empty to use the active theme."
>
  <NumberField
    class="font-size"
    value={prefs.editor_font_size ?? null}
    min={EDITOR_FONT_SIZE_MIN}
    max={EDITOR_FONT_SIZE_MAX}
    nullable
    invalidFallback={16}
    placeholder={themeSizePlaceholder}
    ariaLabel="Editor font size"
    oncommit={(next) => commitFontSize(next)}
  />
  <button
    type="button"
    class="use-theme"
    onclick={() => commitFontSize(null)}
    >Use theme</button
  >
</SettingField>

<SettingField
  label="Date format"
  hint="Default used by @today and pre-selected in the @date picker."
>
  <select
    value={prefs.date_format}
    onchange={(e) =>
      commit((p) => ({ ...p, date_format: e.currentTarget.value }))}
  >
    {#each DATE_FORMATS as f (f.id)}
      <option value={f.id}>{f.label}</option>
    {/each}
  </select>
</SettingField>

<SettingField
  label="Strip trailing whitespace"
  hint="Remove trailing spaces and tabs from each line on save. Applies to every editable text buffer."
>
  <PillToggle
    label="Strip on save"
    checked={prefs.strip_trailing_whitespace_on_save}
    ontoggle={(on) =>
      commit((p) => ({ ...p, strip_trailing_whitespace_on_save: on }))}
  />
</SettingField>

<SettingField
  label="Editor page width"
  hint="Cap the editor text column as a share of the window width. 100% removes the cap."
>
  <SliderField
    value={ratioToPct(prefs.page_width_ratio)}
    min={PAGE_WIDTH_MIN_PCT}
    max={PAGE_WIDTH_MAX_PCT}
    step={PAGE_WIDTH_STEP_PCT}
    format={(v) => `${v}%`}
    ariaLabel="Editor page width percent"
    oncommit={(pct) => commit((p) => ({ ...p, page_width_ratio: pct / 100 }))}
  />
</SettingField>

<SurfaceThemeField kind="editor" {prefs} {commit} />

<style>
  /* The number input lives inside NumberField now, so the width
     reaches it through :global (same trick SettingField uses). */
  :global(input.font-size) {
    width: 7em;
    min-width: 7em;
  }
  .use-theme {
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .use-theme:hover {
    border-color: var(--btn-hover);
  }
</style>
