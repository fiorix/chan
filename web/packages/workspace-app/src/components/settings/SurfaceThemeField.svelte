<script lang="ts">
  // The per-surface body-theme row: pin one Hybrid surface's body to
  // Light or Dark independently of the app theme, or Inherit it. Lives
  // in the surface's own Settings section, matching the launcher's
  // per-surface theme commands. Inherit drops the key so the surface
  // follows the app theme again.

  import type {
    HybridSurfaceKind,
    Preferences,
    SurfaceThemeChoice,
  } from "../../api/types";
  import {
    clearHybridSurfaceTheme,
    setHybridSurfaceTheme,
    withHybridSurfaceTheme,
  } from "../../state/store.svelte";
  import type { CommitFn } from "./commit";
  import SettingField from "./SettingField.svelte";
  import PillRadio from "./PillRadio.svelte";

  let {
    kind,
    prefs,
    commit,
  }: {
    kind: HybridSurfaceKind;
    prefs: Preferences;
    commit: CommitFn;
  } = $props();

  const LABELS: Record<HybridSurfaceKind, string> = {
    editor: "Editor body theme",
    terminal: "Terminal body theme",
    browser: "File browser body theme",
    graph: "Graph body theme",
    dashboard: "Dashboard body theme",
  };

  const OPTIONS = [
    { value: "inherit", label: "Inherit" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;

  // Reuse the store setters (they apply the skin live and persist through
  // the same serial config chain), mirroring how the app theme reuses
  // setThemeChoice; the optimistic buffer slice keeps the control in sync.
  // Both sides merge-versus-delete through the store's
  // withHybridSurfaceTheme, so the buffer and the persist agree.
  function selectSurfaceTheme(choice: string): void {
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
</script>

<SettingField
  label={LABELS[kind]}
  hint="Pin this surface's body to Light or Dark independently of the app theme, or Inherit it."
>
  <PillRadio
    name={`settings-surface-theme-${kind}`}
    ariaLabel={`${LABELS[kind]} override`}
    value={prefs.hybrid_surface_themes?.[kind] ?? "inherit"}
    options={OPTIONS}
    onselect={selectSurfaceTheme}
  />
</SettingField>
