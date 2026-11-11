<script lang="ts">
  // Global settings: the knobs that belong to no single surface. App
  // theme reuses `setThemeChoice` so the chrome re-skins the instant it
  // is picked. Privacy belongs to the viewer; other preferences use commit.

  import type { BubbleOverlayMode, Preferences, ThemeChoice } from "../../api/types";
  import { setThemeChoice } from "../../state/store.svelte";
  import { setWindowTabBarPreference, windowTabBar } from "../../state/windowTabBar.svelte";
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

  // Title bar tabs is chan-desktop's own setting, not a preference of the
  // server this window shows: the desktop stores it and every window
  // switches when it hears, so the row reports its own write.
  let titlebarTabsRefusal = $state<string | null>(null);

  async function toggleTitlebarTabs(on: boolean): Promise<void> {
    const status = await commit((p) => p, () => setWindowTabBarPreference(on), {
      ownStatus: true,
    });
    titlebarTabsRefusal = typeof status === "object" ? status.error : null;
  }
</script>

<SettingField
  label="Privacy mode"
  hint="While recording or sharing your screen, hide computer and gateway names, addresses, connection scripts and tokens, workspace paths in Computers, WireGuard file paths and public keys, connection errors, launcher notices and action details, window labels in Computers and window titles, the pane list's heading and terminal program details, the Metrics slide's host name and chan home path, the command launcher's window labels and workspace names, and the Workspace slide's root path. Reveal individual fields where an eye button is shown. Shared across Chan desktop windows, or browser tabs at the same address. Screen recording is not detected automatically."
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
  label="Dashboard carousel"
  pref="empty_pane_carousel_cycling"
  hint="Auto-rotate the Dashboard tab's slides."
>
  <PillToggle
    label="Auto-rotate"
    checked={prefs.empty_pane_carousel_cycling ?? true}
    ontoggle={(on) =>
      commit((p) => ({ ...p, empty_pane_carousel_cycling: on }))}
  />
</SettingField>

{#if windowTabBar.available}
  <SettingField
    label="Title bar tabs"
    hint="Show the active pane's tabs in the window's title bar, beside a button that lists every pane and tab of the window; the other panes draw no tab strip. This is chan-desktop's own setting and applies live to every open window."
  >
    <PillToggle
      label="In the title bar"
      checked={windowTabBar.preferred}
      ontoggle={(on) => void toggleTitlebarTabs(on)}
    />
    {#if titlebarTabsRefusal}
      <p class="refusal" role="alert">Not saved: {titlebarTabsRefusal}</p>
    {/if}
  </SettingField>
{/if}

<!-- The tabs in the title bar take no room from a pane, so auto-hide
     applies only while they stay in the panes. -->
{#if !windowTabBar.on}
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
{/if}

<style>
  /* SettingField's refusal line, for the one row that reports its own. */
  .refusal {
    flex-basis: 100%;
    margin: 4px 0 0;
    color: var(--danger, #ef4444);
    font-size: 12px;
  }
</style>
