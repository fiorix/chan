<script lang="ts">
  // Global settings: the knobs that belong to no single surface. App
  // theme reuses `setThemeChoice` so the chrome re-skins the instant it
  // is picked; the rest write single fields through the parent's commit.

  import type { BubbleOverlayMode, Preferences, ThemeChoice } from "../../api/types";
  import { setThemeChoice } from "../../state/store.svelte";
  import type { CommitFn } from "./commit";
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

<SettingField
  label="Empty-pane carousel"
  hint="Auto-rotate the welcome carousel shown in an empty single pane."
>
  <PillToggle
    label="Auto-rotate"
    checked={prefs.empty_pane_carousel_cycling ?? true}
    ontoggle={(on) =>
      commit((p) => ({ ...p, empty_pane_carousel_cycling: on }))}
  />
</SettingField>
