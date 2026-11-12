<script lang="ts">
  // Terminal settings: the server-config `terminal` slice. Program status
  // changes every session at once; the other terminal controls here apply
  // to newly spawned terminals. The scrollback slider and the free-text
  // TERM field debounce their writes. Each field takes its words, and a
  // toggle or a choice its change, from the settings index.

  import type { Preferences } from "../../api/types";
  import { DEFAULT_SECRET_MASK_SUFFIXES } from "../../terminal/secretMasking";
  import {
    SCROLLBACK_MB_MIN,
    SCROLLBACK_MB_MAX,
    clampScrollbackMb,
  } from "../../terminal/scrollback";
  import {
    TERMINAL_FONT_SIZE_MIN,
    TERMINAL_FONT_SIZE_MAX,
  } from "../../terminal/fontSize";
  import {
    TERMINAL_BACKGROUND_OPACITY_MIN,
    TERMINAL_BACKGROUND_OPACITY_MAX,
    clampBackgroundOpacity,
  } from "../../terminal/backgroundOpacity";
  import {
    desktopTerminalOpacity,
    setDesktopTerminalOpacity,
  } from "../../terminal/desktopTerminalOpacity.svelte";
  import { isTauriDesktop } from "../../api/desktop";
  import { commitSetting, type CommitFn, type SaveStatus } from "./commit";
  import {
    TERMINAL_COLOR_FIELDS,
    backgroundOpacityLabel,
    chosenIn,
    optionsOf,
    settingEntry,
    toggledIn,
    type TerminalColorField,
  } from "./settingsIndex";
  import { customTerminalColorsUpdate, resetTerminalColorsChange } from "./terminalColors";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import PillRadio from "./PillRadio.svelte";
  import SliderField from "./SliderField.svelte";
  import TextField from "./TextField.svelte";
  import NumberField from "./NumberField.svelte";
  import ChipList from "./ChipList.svelte";
  import ColorField from "./ColorField.svelte";
  import SurfaceThemeField from "./SurfaceThemeField.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const SCROLLBACK = settingEntry("terminal.scrollback");
  const TERM = settingEntry("terminal.term");
  const MCP_ENV = settingEntry("terminal.mcpEnv");
  const MOUSE_CAPTURE = settingEntry("terminal.mouseCapture");
  const ENGINE = settingEntry("terminal.engine");
  const PROGRAM_STATUS = settingEntry("terminal.programStatus");
  const TMUX = settingEntry("terminal.tmux");
  const SECRET_MASKING = settingEntry("terminal.secretMasking");
  const FONT = settingEntry("terminal.font");
  const FONT_SIZE = settingEntry("terminal.fontSize");
  const BACKGROUND_OPACITY = settingEntry("terminal.backgroundOpacity");
  const CUSTOM_COLORS = settingEntry("terminal.customColors");
  const ANSI_CONTRAST = settingEntry("terminal.ansiContrast");
  const COLOR_ROWS = TERMINAL_COLOR_FIELDS.map((key) => ({
    key,
    entry: settingEntry(`terminal.colors.${key}`),
  }));

  // Secret masking is editable here and applies on both backends. The
  // suffix list stays display-only
  // (normalize_terminal_secret_mask_suffixes drops, dedupes and
  // truncates, so a chip editor would have to mirror all three).
  // Absent fields on a pre-field server display the SPA fallback.
  // These are the configured values, read by terminals at spawn:
  // already-open terminals keep the flag and suffixes they started
  // with.
  //
  // The row reads the stored choice: On, Off, or Default while none is
  // stored, when a new terminal takes its window's default by the rule
  // the terminal itself is seeded with. Default removes a stored choice,
  // which then sits in the edit buffer as `null` until the server's view
  // replaces it.
  const secretMaskSuffixes = $derived(
    prefs.terminal.secret_mask_suffixes ?? DEFAULT_SECRET_MASK_SUFFIXES,
  );

  const SCROLLBACK_STEP = 10;

  // Background opacity is chan-desktop's setting. In a desktop window the
  // slider shows the desktop's value and writes it through the host,
  // whatever tenant this window shows; the buffer key is still mutated so
  // the field's status lights for the write. In a browser tab, which never
  // paints it, the row writes the tenant's preference: a server on the
  // desktop's machine shares that file with chan-desktop, which follows it.
  const desktopWindow = isTauriDesktop();
  const backgroundOpacity = $derived(
    desktopWindow
      ? (desktopTerminalOpacity() ?? TERMINAL_BACKGROUND_OPACITY_MAX)
      : clampBackgroundOpacity(prefs.terminal.background_opacity),
  );
  const BACKGROUND_OPACITY_HINT = desktopWindow
    ? "See-through terminal background in every chan-desktop window: below 100 a terminal tab shows the desktop behind the window; text and everything that is not a terminal stay opaque. From 80% to 100%, the default, which is off. This is chan-desktop's own setting and applies live to every open window."
    : "Applies in chan-desktop, where the desktop's own setting governs every terminal tab; a browser tab stays opaque. From 80% to 100%, the default, which is off.";

  function commitBackgroundOpacity(percent: number): void {
    const mutate = (p: Preferences): Preferences => ({
      ...p,
      terminal: { ...p.terminal, background_opacity: percent },
    });
    if (desktopWindow) commit(mutate, () => setDesktopTerminalOpacity(percent));
    else commit(mutate);
  }

  // Terminal font. The Source Code Pro face ships inside the SPA bundle,
  // so picking it is a plain preference write with nothing to fetch and
  // no state where the config claims a font the browser cannot load.
  const currentFont = $derived(chosenIn(FONT, prefs));

  function selectFont(next: string): void {
    if (next === currentFont) return;
    commitSetting(commit, FONT, next);
  }

  // ---- custom terminal colours ------------------------------------------
  // The colour block is atomic: the toggle swaps the whole
  // `terminal_colors` composite, and each colour commit replaces the
  // payload with one field changed (see terminalColors.ts).
  const customTerminalColorsOn = $derived(toggledIn(CUSTOM_COLORS, prefs));
  const customTerminalColors = $derived(prefs.terminal_colors?.custom);

  /// Write one normalized hex (from ColorField) into the custom payload.
  /// The row reports for itself: the three of them write one preference,
  /// so the preference cannot say which row a refusal belongs to.
  function commitTerminalColor(
    field: TerminalColorField,
    hex: string,
  ): Promise<SaveStatus> {
    return commit(
      customTerminalColorsUpdate((custom) => ({ ...custom, [field]: hex })),
      undefined,
      { ownStatus: true },
    );
  }

  function resetTerminalColors(): void {
    commit(resetTerminalColorsChange());
  }
</script>

<SettingField
  setting={SCROLLBACK}
  pref="terminal.scrollback_mb"
  hint="Per-terminal scrollback budget. New terminals only; existing ones keep their scrollback until they restart."
>
  <SliderField
    value={clampScrollbackMb(prefs.terminal.scrollback_mb)}
    min={SCROLLBACK_MB_MIN}
    max={SCROLLBACK_MB_MAX}
    step={SCROLLBACK_STEP}
    format={(v) => `${v} MB`}
    ariaLabel="Terminal scrollback megabytes"
    oncommit={(mb) =>
      commit((p) => ({ ...p, terminal: { ...p.terminal, scrollback_mb: mb } }))}
  />
</SettingField>

<SettingField
  setting={TERM}
  pref="terminal.default_term"
  hint="TERM environment variable for new terminals. Blank falls back to xterm-256color."
>
  <TextField
    value={prefs.terminal.default_term ?? ""}
    placeholder="xterm-256color"
    ariaLabel="Terminal TERM value"
    oncommit={(value) =>
      commit((p) => ({ ...p, terminal: { ...p.terminal, default_term: value } }))}
  />
</SettingField>

<SettingField
  setting={MCP_ENV}
  pref="terminal.mcp_env"
  hint="Expose the chan MCP env vars (CHAN_MCP_*) to new terminals so agent CLIs can find the MCP server."
>
  <PillToggle
    label={MCP_ENV.caption}
    checked={toggledIn(MCP_ENV, prefs)}
    ontoggle={(on) => commitSetting(commit, MCP_ENV, on)}
  />
</SettingField>

<SettingField
  setting={MOUSE_CAPTURE}
  pref="terminal.mouse_capture"
  hint="Let full-screen terminal apps capture the mouse. Turn off to keep click-drag text selection over them. New terminals only."
>
  <PillToggle
    label={MOUSE_CAPTURE.caption}
    checked={toggledIn(MOUSE_CAPTURE, prefs)}
    ontoggle={(on) => commitSetting(commit, MOUSE_CAPTURE, on)}
  />
</SettingField>

<SettingField
  setting={ENGINE}
  pref="terminal.ghostty"
  hint="What parses and renders new terminals: Ghostty's WASM engine, the default on every platform, or xterm.js. On Linux desktops using xterm.js's DOM renderer, box drawing and block characters can show gaps at cell boundaries; Ghostty draws those characters itself. The engine loads from this server the first time a ghostty terminal opens, and falls back to xterm.js if it cannot. Reload to apply."
>
  <PillRadio
    name="settings-terminal-engine"
    ariaLabel="Terminal engine"
    value={chosenIn(ENGINE, prefs)}
    options={optionsOf(ENGINE)}
    onselect={(engine) => commitSetting(commit, ENGINE, engine)}
  />
</SettingField>

<SettingField
  setting={PROGRAM_STATUS}
  pref="terminal.program_status"
  hint="Show what programs report through OSC 7501 and mark chan's own waits."
>
  <PillToggle
    label={PROGRAM_STATUS.caption}
    checked={toggledIn(PROGRAM_STATUS, prefs)}
    ontoggle={(on) => commitSetting(commit, PROGRAM_STATUS, on)}
  />
</SettingField>

<SettingField
  setting={TMUX}
  pref="terminal.tmux"
  hint="Honor the marker tmux -CC prints. A local tmux enters at once; any other foreground program asks first. Applies to new markers in every terminal; a connection already running is left alone."
>
  <PillToggle
    label={TMUX.caption}
    checked={toggledIn(TMUX, prefs)}
    ontoggle={(on) => commitSetting(commit, TMUX, on)}
  />
</SettingField>

<SettingField
  setting={SECRET_MASKING}
  pref="terminal.secret_masking"
  hint="Masks secret-looking NAME=value values on screen, on the xterm.js and ghostty backends alike. The buffer stays copyable. New terminals only. Default stores no choice: masking is then on in a control terminal and off in every other window. The terminal menu has an ephemeral per-tab toggle."
>
  <PillRadio
    name="settings-terminal-secret-masking"
    ariaLabel="Secret masking"
    value={chosenIn(SECRET_MASKING, prefs)}
    options={optionsOf(SECRET_MASKING)}
    onselect={(choice) => commitSetting(commit, SECRET_MASKING, choice)}
  />
  <details class="suffixes">
    <summary>Suffixes ({secretMaskSuffixes.length})</summary>
    <ChipList names={secretMaskSuffixes} readonly ariaLabel="Secret mask suffixes" />
  </details>
</SettingField>

<SettingField
  setting={FONT}
  pref="terminal.font"
  hint="Font for new terminals. Source Code Pro ships with chan and renders identically on every OS; existing terminals keep their font until they restart."
>
  <select
    value={currentFont}
    onchange={(e) => selectFont(e.currentTarget.value)}
    aria-label="Terminal font"
  >
    {#each optionsOf(FONT) as font (font.value)}
      <option value={font.value}>{font.label}</option>
    {/each}
  </select>
</SettingField>

<SettingField
  setting={FONT_SIZE}
  pref="terminal.font_size"
  hint="Font size for newly constructed terminal surfaces. Mounted renderers and their PTY geometry stay unchanged."
>
  <NumberField
    class="terminal-font-size"
    value={prefs.terminal.font_size ?? 14}
    min={TERMINAL_FONT_SIZE_MIN}
    max={TERMINAL_FONT_SIZE_MAX}
    invalidFallback={14}
    ariaLabel="Terminal font size"
    oncommit={(next) =>
      next !== null &&
      commit((p) => ({ ...p, terminal: { ...p.terminal, font_size: next } }))}
  />
  <span class="value">px</span>
</SettingField>

<SettingField
  setting={BACKGROUND_OPACITY}
  pref="terminal.background_opacity"
  hint={BACKGROUND_OPACITY_HINT}
>
  <SliderField
    value={backgroundOpacity}
    min={TERMINAL_BACKGROUND_OPACITY_MIN}
    max={TERMINAL_BACKGROUND_OPACITY_MAX}
    step={1}
    format={backgroundOpacityLabel}
    ariaLabel="Terminal background opacity percent"
    oncommit={commitBackgroundOpacity}
  />
</SettingField>

<SettingField
  setting={CUSTOM_COLORS}
  pref="terminal_colors"
  hint="Override terminal background, foreground, and cursor colours. The terminal's standard Inherit, Light, or Dark choice remains underneath."
>
  <PillToggle
    label={CUSTOM_COLORS.caption}
    checked={customTerminalColorsOn}
    ontoggle={(on) => commitSetting(commit, CUSTOM_COLORS, on)}
  />
</SettingField>

{#if customTerminalColorsOn && customTerminalColors}
  <SettingField setting={ANSI_CONTRAST} pref="terminal_colors.custom">
    <PillRadio
      name="settings-terminal-contrast"
      ariaLabel="Terminal ANSI contrast"
      value={chosenIn(ANSI_CONTRAST, prefs)}
      options={optionsOf(ANSI_CONTRAST)}
      onselect={(contrast) => commitSetting(commit, ANSI_CONTRAST, contrast)}
    />
  </SettingField>
  <div class="terminal-colours">
    {#each COLOR_ROWS as row (row.key)}
      <ColorField
        id={`terminal-colour-${row.key}`}
        setting={row.entry.id}
        label={row.entry.caption}
        value={customTerminalColors[row.key]}
        oncommit={(hex) => (hex === null ? undefined : commitTerminalColor(row.key, hex))}
      />
    {/each}
    <button type="button" class="plain-button reset-terminal-colours" onclick={resetTerminalColors}>
      Reset to current standard
    </button>
  </div>
{/if}

<SurfaceThemeField kind="terminal" {prefs} {commit} />

<style>
  .value {
    color: var(--text-secondary);
    font-size: 13px;
    min-width: 4.5em;
    text-align: right;
  }
  /* The number input lives inside NumberField, so the width
     reaches it through :global (same trick SettingField uses). */
  :global(input.terminal-font-size) {
    width: 6em;
    min-width: 6em;
  }
  .suffixes summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .terminal-colours {
    display: grid;
    gap: 10px;
    padding: 12px 0 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .plain-button {
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .plain-button:hover {
    border-color: var(--btn-hover);
  }
  .reset-terminal-colours {
    justify-self: start;
  }
</style>
