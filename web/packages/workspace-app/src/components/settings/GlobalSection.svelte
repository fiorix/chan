<script lang="ts">
  // Global settings: the knobs that belong to no single surface. Each
  // field takes its words, and a preference its change, from the settings
  // index. Privacy belongs to the viewer; other preferences use commit.

  import type { Preferences } from "../../api/types";
  import { setWindowTabBarPreference, windowTabBar } from "../../state/windowTabBar.svelte";
  import { commitSetting, type CommitFn } from "./commit";
  import { privacy, setPrivacy, retryPrivacy } from "@chan/web-shared/privacy";
  import { chosenIn, optionsOf, settingEntry, toggledIn } from "./settingsIndex";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";
  import PillToggle from "./PillToggle.svelte";

  let { prefs, commit }: { prefs: Preferences; commit: CommitFn } = $props();

  const PRIVACY = settingEntry("global.privacy");
  const PRIVACY_MASKING = settingEntry("global.privacyTerminalMasking");
  const THEME = settingEntry("global.theme");
  const BUBBLES = settingEntry("global.watcherBubbles");
  const CAROUSEL = settingEntry("global.dashboardCarousel");
  const TITLEBAR_TABS = settingEntry("global.titlebarTabs");
  const PANE_STRIP = settingEntry("global.paneStrip");

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
  setting={PRIVACY}
  hint="While recording or sharing your screen, hide computer and gateway names, addresses, connection scripts and tokens, workspace paths in Computers, WireGuard file paths and public keys, connection errors, launcher notices and action details, window labels in Computers and window titles, terminal program details, the Metrics slide's host name and chan home path, the command launcher's window labels and workspace names, and the Workspace slide's root path. Reveal individual fields where an eye button is shown. Shared across Chan desktop windows, or browser tabs at the same address. Screen recording is not detected automatically."
>
  <PillToggle label={PRIVACY.caption} checked={privacy.enabled} disabled={!privacy.ready || privacy.saving} ontoggle={(enabled) => void setPrivacy({ enabled })} />
  <PillToggle setting={PRIVACY_MASKING.id} label={PRIVACY_MASKING.caption} checked={privacy.mask_terminal_secrets} disabled={!privacy.ready || privacy.saving} ontoggle={(mask_terminal_secrets) => void setPrivacy({ mask_terminal_secrets })} />
  {#if privacy.error}<p role="alert">{privacy.error}</p>{/if}
  {#if !privacy.ready}<button type="button" onclick={retryPrivacy}>Retry privacy settings</button>{/if}
</SettingField>

<SettingField
  setting={THEME}
  hint="App-wide colour theme. System follows your OS setting."
  pref="theme"
>
  <PillRadio
    name="settings-theme"
    ariaLabel="App theme"
    value={chosenIn(THEME, prefs)}
    options={optionsOf(THEME)}
    onselect={(v) => commitSetting(commit, THEME, v)}
  />
</SettingField>

<SettingField
  setting={BUBBLES}
  pref="bubble_overlay_mode"
  hint="Show filesystem-watch notices inline, or collapse them to a count tray until expanded."
>
  <PillRadio
    name="settings-bubbles"
    ariaLabel="Watcher bubbles"
    value={chosenIn(BUBBLES, prefs)}
    options={optionsOf(BUBBLES)}
    onselect={(v) => commitSetting(commit, BUBBLES, v)}
  />
</SettingField>

<SettingField
  setting={CAROUSEL}
  pref="empty_pane_carousel_cycling"
  hint="Auto-rotate the Dashboard tab's slides."
>
  <PillToggle
    label={CAROUSEL.caption}
    checked={toggledIn(CAROUSEL, prefs)}
    ontoggle={(on) => commitSetting(commit, CAROUSEL, on)}
  />
</SettingField>

{#if windowTabBar.available}
  <SettingField
    setting={TITLEBAR_TABS}
    hint="Show the active pane's tabs in the window's title bar, beside a button that lists every pane and tab of the window; the other panes draw no tab strip. This is chan-desktop's own setting and applies live to every open window."
  >
    <PillToggle
      label={TITLEBAR_TABS.caption}
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
    setting={PANE_STRIP}
    pref="pane_strip_auto_hide"
    hint="Hide a pane's tab strip until the side it shows holds two or more tabs. New tabs still come from the shortcuts and the command launcher, and a tab dropped in the pane's centre lands there, as does a file outside an editor."
  >
    <PillToggle
      label={PANE_STRIP.caption}
      checked={toggledIn(PANE_STRIP, prefs)}
      ontoggle={(on) => commitSetting(commit, PANE_STRIP, on)}
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
