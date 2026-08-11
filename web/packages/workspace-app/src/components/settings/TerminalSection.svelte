<script lang="ts">
  // Terminal settings: the server-config `terminal` slice. All fields
  // are spawn-time, so a change applies to newly spawned terminals. The
  // scrollback slider and the free-text TERM field debounce their writes.

  import type { Preferences, TerminalFontChoice } from "../../api/types";
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
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";
  import SliderField from "./SliderField.svelte";
  import TextField from "./TextField.svelte";
  import NumberField from "./NumberField.svelte";
  import ChipList from "./ChipList.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  // Secret masking is display-only here (hand-edited TOML / PATCH persist
  // it; the roadmap scopes Settings to visibility). Absent fields on a
  // pre-field server display the SPA fallback. These are the configured
  // values, read by terminals at spawn: already-open terminals keep the
  // flag and suffixes they started with.
  const secretMaskingOn = $derived(prefs.terminal.secret_masking ?? false);
  const secretMaskSuffixes = $derived(
    prefs.terminal.secret_mask_suffixes ?? DEFAULT_SECRET_MASK_SUFFIXES,
  );

  const SCROLLBACK_STEP = 10;

  // Terminal font. The Source Code Pro face ships inside the SPA bundle,
  // so picking it is a plain preference write with nothing to fetch and
  // no state where the config claims a font the browser cannot load.
  const currentFont = $derived(
    (prefs.terminal.font ?? "os-default") as TerminalFontChoice,
  );

  function selectFont(next: TerminalFontChoice): void {
    if (next === currentFont) return;
    commit((p) => ({ ...p, terminal: { ...p.terminal, font: next } }));
  }
</script>

<SettingField
  label="Scrollback"
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
  label="TERM"
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
  label="MCP discovery"
  hint="Expose the chan MCP env vars (CHAN_MCP_*) to new terminals so agent CLIs can find the MCP server."
>
  <PillToggle
    label="Enable in new terminals"
    checked={prefs.terminal.mcp_env ?? false}
    ontoggle={(on) =>
      commit((p) => ({ ...p, terminal: { ...p.terminal, mcp_env: on } }))}
  />
</SettingField>

<SettingField
  label="Mouse capture"
  hint="Let full-screen terminal apps capture the mouse. Turn off to keep click-drag text selection over them. New terminals only."
>
  <PillToggle
    label="Allow in new terminals"
    checked={prefs.terminal.mouse_capture ?? true}
    ontoggle={(on) =>
      commit((p) => ({ ...p, terminal: { ...p.terminal, mouse_capture: on } }))}
  />
</SettingField>

<SettingField
  label="Ghostty backend"
  hint="Parse and render new terminals with Ghostty's WASM engine instead of xterm.js. On by default on Linux, where xterm.js falls back to a renderer that leaves a gap at every cell boundary and box drawing comes out dotted; off elsewhere, where xterm.js renders the grid correctly. Secret masking is xterm-only and does nothing here. The engine loads from this server the first time a ghostty terminal opens, and falls back to xterm.js if it cannot. New terminals only."
>
  <PillToggle
    label="Use ghostty-web in new terminals"
    checked={prefs.terminal.ghostty ?? false}
    ontoggle={(on) =>
      commit((p) => ({ ...p, terminal: { ...p.terminal, ghostty: on } }))}
  />
</SettingField>

<SettingField
  label="Secret masking"
  hint="Masks secret-looking NAME=value values in xterm.js terminals; the buffer stays copyable. Configured in server.toml (terminal.secret_masking, terminal.secret_mask_suffixes); new terminals only. The terminal menu has an ephemeral per-tab toggle."
>
  <span class="value">{secretMaskingOn ? "Enabled" : "Disabled"}</span>
  <details class="suffixes">
    <summary>Suffixes ({secretMaskSuffixes.length})</summary>
    <ChipList names={secretMaskSuffixes} readonly ariaLabel="Secret mask suffixes" />
  </details>
</SettingField>

<SettingField
  label="Terminal font"
  hint="Font for new terminals. Source Code Pro ships with chan and renders identically on every OS; existing terminals keep their font until they restart."
>
  <select
    value={currentFont}
    onchange={(e) =>
      selectFont(e.currentTarget.value as TerminalFontChoice)}
    aria-label="Terminal font"
  >
    <option value="os-default">OS default (mono)</option>
    <option value="source-code-pro">Source Code Pro</option>
  </select>
</SettingField>

<SettingField
  label="Terminal font size"
  hint="Font size for newly constructed terminal surfaces. Mounted renderers and their PTY geometry stay unchanged."
>
  <NumberField
    class="font-size"
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

<style>
  .value {
    color: var(--text-secondary);
    font-size: 13px;
    min-width: 4.5em;
    text-align: right;
  }
  /* The number input lives inside NumberField now, so the width
     reaches it through :global (same trick SettingField uses). */
  :global(input.font-size) {
    width: 6em;
    min-width: 6em;
  }
  .suffixes summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 13px;
  }
</style>
