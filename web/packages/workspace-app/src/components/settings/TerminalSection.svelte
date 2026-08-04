<script lang="ts">
  // Terminal settings: the server-config `terminal` slice. All fields
  // are spawn-time, so a change applies to newly spawned terminals. The
  // scrollback slider and the free-text TERM field debounce their writes.

  import { api } from "../../api/client";
  import type { Preferences, TerminalFontChoice } from "../../api/types";
  import { DEFAULT_SECRET_MASK_SUFFIXES } from "../../terminal/secretMasking";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillToggle from "./PillToggle.svelte";

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

  const SCROLLBACK_MIN = 10;
  const SCROLLBACK_MAX = 500;
  const SCROLLBACK_STEP = 10;
  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 32;
  function clampScrollback(v: number | undefined): number {
    return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, v ?? 50));
  }

  // Local slider position so the thumb tracks the drag; the effect
  // seeds it from the buffer and resyncs when the stored value changes.
  let scrollback = $state(50);
  $effect(() => {
    scrollback = clampScrollback(prefs.terminal.scrollback_mb);
  });
  let scrollbackTimer: ReturnType<typeof setTimeout> | null = null;
  function onScrollbackInput(): void {
    if (scrollbackTimer) clearTimeout(scrollbackTimer);
    const mb = scrollback;
    scrollbackTimer = setTimeout(() => {
      scrollbackTimer = null;
      commit((p) => ({ ...p, terminal: { ...p.terminal, scrollback_mb: mb } }));
    }, 200);
  }

  function clampFontSize(value: number): number {
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
  }

  let fontSizeText = $state("14");
  $effect(() => {
    fontSizeText = String(clampFontSize(prefs.terminal.font_size ?? 14));
  });

  function commitFontSize(): void {
    const parsed = fontSizeText.trim() === "" ? 14 : Number(fontSizeText);
    const next = clampFontSize(Number.isFinite(parsed) ? parsed : 14);
    fontSizeText = String(next);
    if ((prefs.terminal.font_size ?? 14) === next) return;
    commit((p) => ({
      ...p,
      terminal: { ...p.terminal, font_size: next },
    }));
  }

  function onFontSizeKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitFontSize();
    event.currentTarget.blur();
  }

  // TERM is a controlled field (value from the buffer); the debounce
  // reads the live input value so a per-keystroke PATCH is avoided
  // while an in-flight edit is preserved (the buffer is stable between
  // commits).
  let termTimer: ReturnType<typeof setTimeout> | null = null;
  function onTermInput(value: string): void {
    if (termTimer) clearTimeout(termTimer);
    termTimer = setTimeout(() => {
      termTimer = null;
      commit((p) => ({ ...p, terminal: { ...p.terminal, default_term: value } }));
    }, 400);
  }

  // Terminal font. Enabling Source Code Pro downloads the woff2 into the
  // user config dir first; the preference is persisted only after the
  // download lands, so the config never claims SCP while the file is
  // missing (the terminal card holds the same invariant). `pendingFont`
  // shows the picked value in the select while the download is in flight,
  // before the buffer slice is committed.
  let fontDownloading = $state(false);
  let fontStatus = $state<string | null>(null);
  let pendingFont = $state<TerminalFontChoice | null>(null);
  const currentFont = $derived(
    (prefs.terminal.font ?? "os-default") as TerminalFontChoice,
  );
  const displayFont = $derived(pendingFont ?? currentFont);

  async function selectFont(next: TerminalFontChoice): Promise<void> {
    if (next === displayFont) return;
    fontStatus = null;
    if (next === "source-code-pro") {
      pendingFont = "source-code-pro";
      fontDownloading = true;
      fontStatus = "Downloading Source Code Pro...";
      try {
        await api.fontsSourceCodeProDownload();
        commit((p) => ({
          ...p,
          terminal: { ...p.terminal, font: "source-code-pro" },
        }));
        fontStatus = "Source Code Pro ready.";
      } catch (e) {
        // Leave the preference at os-default; the select reverts when
        // pendingFont clears, so the SPA never claims SCP is active.
        fontStatus = `Download failed: ${(e as Error).message}`;
      } finally {
        pendingFont = null;
        fontDownloading = false;
      }
    } else {
      commit((p) => ({ ...p, terminal: { ...p.terminal, font: "os-default" } }));
    }
  }
</script>

<SettingField
  label="Scrollback"
  hint="Per-terminal scrollback budget. New terminals only; existing ones keep their scrollback until they restart."
>
  <input
    type="range"
    min={SCROLLBACK_MIN}
    max={SCROLLBACK_MAX}
    step={SCROLLBACK_STEP}
    bind:value={scrollback}
    oninput={onScrollbackInput}
    aria-label="Terminal scrollback megabytes"
  />
  <span class="value">{scrollback} MB</span>
</SettingField>

<SettingField
  label="TERM"
  hint="TERM environment variable for new terminals. Blank falls back to xterm-256color."
>
  <input
    type="text"
    value={prefs.terminal.default_term ?? ""}
    oninput={(e) => onTermInput(e.currentTarget.value)}
    placeholder="xterm-256color"
    spellcheck={false}
    aria-label="Terminal TERM value"
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
  hint="Experimental: parse and render new terminals with Ghostty's WASM engine instead of xterm.js. The engine loads from this server the first time a ghostty terminal opens, and falls back to xterm.js if it cannot. New terminals only."
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
    <ul class="chips readonly" aria-label="Secret mask suffixes">
      {#each secretMaskSuffixes as suffix (suffix)}
        <li class="chip"><span class="chip-name">{suffix}</span></li>
      {/each}
    </ul>
  </details>
</SettingField>

<SettingField
  label="Terminal font"
  hint="Font for new terminals. Source Code Pro downloads ~80 KB into your config dir on first enable; existing terminals keep their font until they restart."
>
  <select
    value={displayFont}
    disabled={fontDownloading}
    onchange={(e) =>
      void selectFont(e.currentTarget.value as TerminalFontChoice)}
    aria-label="Terminal font"
  >
    <option value="os-default">OS default (mono)</option>
    <option value="source-code-pro">Source Code Pro</option>
  </select>
  {#if fontStatus}
    <span class="font-status" role="status">{fontStatus}</span>
  {/if}
</SettingField>

<SettingField
  label="Terminal font size"
  hint="Font size for newly constructed terminal surfaces. Mounted renderers and their PTY geometry stay unchanged."
>
  <input
    class="font-size"
    type="number"
    min={FONT_SIZE_MIN}
    max={FONT_SIZE_MAX}
    step="1"
    value={fontSizeText}
    oninput={(event) => (fontSizeText = event.currentTarget.value)}
    onblur={commitFontSize}
    onkeydown={onFontSizeKeydown}
    aria-label="Terminal font size"
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
  .font-status {
    color: var(--text-secondary);
    font-size: 12px;
  }
  input.font-size {
    width: 6em;
    min-width: 6em;
  }
  /* Read-only value chips, same vocabulary as the workspace settings'
     excluded-directories baseline list. */
  .suffixes summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .chips {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: var(--bg-card, rgba(0, 0, 0, 0.04));
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 13px;
    color: var(--text);
  }
  .chips.readonly .chip {
    color: var(--text-secondary);
  }
  .chip-name {
    font-family: var(--chan-editor-code-family, monospace);
  }
</style>
