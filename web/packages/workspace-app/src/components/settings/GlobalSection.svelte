<script lang="ts">
  // Global settings: the knobs that belong to no single surface. App
  // theme reuses `setThemeChoice` so the chrome re-skins the instant it
  // is picked. Privacy belongs to the viewer; other preferences use commit.

  import type { BubbleOverlayMode, Preferences, ThemeChoice } from "../../api/types";
  import { setThemeChoice } from "../../state/store.svelte";
  import type { CommitFn } from "./commit";
  import { privacy, setPrivacy, retryPrivacy } from "@chan/web-shared/privacy";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";
  import PillToggle from "./PillToggle.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const THEMES = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  const BUBBLES = [
    { value: "stack", label: "Inline" },
    { value: "tray", label: "Tray" },
  ] as const;
</script>

<SettingField
  label="Privacy mode"
  hint="Hide computer and gateway names, addresses, connection scripts and tokens while recording or sharing your screen. Reveal individual fields with their eye button. Shared across Chan desktop windows, or browser tabs at the same address. Screen recording is not detected automatically."
>
  <PillToggle label="Privacy mode on" checked={privacy.enabled} disabled={!privacy.ready || privacy.saving} ontoggle={(enabled) => void setPrivacy({ enabled })} />
  <PillToggle label="Also enable terminal secret masking" checked={privacy.mask_terminal_secrets} disabled={!privacy.ready || privacy.saving} ontoggle={(mask_terminal_secrets) => void setPrivacy({ mask_terminal_secrets })} />
  {#if privacy.error}<p role="alert">{privacy.error}</p>{/if}
  {#if !privacy.ready}<button type="button" onclick={retryPrivacy}>Retry privacy settings</button>{/if}
</SettingField>

<SettingField
  label="Theme"
  hint="App-wide colour theme. System follows your OS setting."
  pref="theme"
>
  <PillRadio
    name="settings-theme"
    ariaLabel="App theme"
    value={prefs.theme}
    options={THEMES}
    onselect={(v) =>
      commit(
        (p) => ({ ...p, theme: v as ThemeChoice }),
        () => setThemeChoice(v as ThemeChoice),
      )}
  />
</SettingField>

<SettingField
  label="Watcher bubbles"
  pref="bubble_overlay_mode"
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

<SettingField
  label="Empty-pane carousel"
  pref="empty_pane_carousel_cycling"
  hint="Auto-rotate the welcome carousel shown in an empty single pane."
>
  <PillToggle
    label="Auto-rotate"
    checked={prefs.empty_pane_carousel_cycling ?? true}
    ontoggle={(on) =>
      commit((p) => ({ ...p, empty_pane_carousel_cycling: on }))}
  />
</SettingField>

<SettingField
  label="Pane strip"
  pref="pane_strip_auto_hide"
  hint="Hide a pane's tab strip until the side it shows holds two or more tabs. New tabs still come from the shortcuts and the command launcher, and a tab dropped in the pane's centre lands there, as does a file outside an editor."
>
  <PillToggle
    label="Auto-hide"
    checked={prefs.pane_strip_auto_hide ?? false}
    ontoggle={(on) => commit((p) => ({ ...p, pane_strip_auto_hide: on }))}
  />
</SettingField>
