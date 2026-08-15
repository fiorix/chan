<script lang="ts">
  // The configuration surface: a launcher-reachable web form over the
  // split-store PreferencesView. It reads the current config, presents
  // editable fields grouped by topic, and writes each change back as a
  // narrow revisioned patch through the shared config-write helper. A
  // stale write replays its mutation against the returned current state. The
  // form re-reads on the config_changed WS event (a sibling window's
  // change refreshes workspace.info.preferences), so every open window
  // stays in sync.

  import { Maximize2, Minimize2, X } from "lucide-svelte";
  import { tick } from "svelte";
  import type { Preferences, PreferencesPatch } from "../api/types";
  import { api } from "../api/client";
  import {
    closeSettings,
    currentPreferences,
    settingsPanel,
    updateGlobalConfigSerial,
    workspace,
  } from "../state/store.svelte";
  import { overlayMaximized, setOverlayMaximized } from "../state/pageWidth.svelte";
  import { bumpTabFocusPulse } from "../state/tabs.svelte";
  import { applyEditorFontSize, applyEditorTheme } from "../state/editorTheme";
  import { editorToolsPrefs } from "../state/editorTools.svelte";
  import { DATE_FORMATS } from "../editor/dateFormats";
  import OverlayShell from "./OverlayShell.svelte";
  import type { CommitFn } from "./settings/commit";
  import {
    SETTINGS_SECTIONS,
    type SettingsSectionId,
  } from "./settings/sections";
  import GlobalSection from "./settings/GlobalSection.svelte";
  import EditorSection from "./settings/EditorSection.svelte";
  import TerminalSection from "./settings/TerminalSection.svelte";
  import BrowserSection from "./settings/BrowserSection.svelte";
  import GraphSection from "./settings/GraphSection.svelte";
  import DashboardSection from "./settings/DashboardSection.svelte";
  import SearchSection from "./settings/SearchSection.svelte";
  // The per-OS shortcut-assignment grid is the Keymap lane's; this
  // surface owns only its placement in the section below.
  import KeymapSettings from "./KeymapSettings.svelte";
  // The per-workspace tab; its controls call their own endpoints and do not
  // flow through the PreferencesView buffer the per-machine sections use.
  import WorkspaceSection from "./settings/workspace/WorkspaceSection.svelte";

  // Editable buffer of the split-store preferences. Refetched on each
  // open, and re-seeded whenever the server view changes (a sibling
  // window's config_changed refreshes workspace.info.preferences),
  // except while a local write is in flight so an in-progress edit is
  // not stomped mid-round-trip.
  let editing = $state<Preferences | null>(null);
  let loadError = $state<string | null>(null);
  let inflight = $state(0);
  let loading = false;
  let lastServerSnap = "";
  let settingsEl: HTMLDivElement | undefined = $state();
  let sectionNavEl: HTMLElement | undefined = $state();

  function clone(p: Preferences): Preferences {
    return JSON.parse(JSON.stringify(p)) as Preferences;
  }

  /// Normalize the fields the form presents that carry legacy aliases,
  /// so a persisted "tight" spacing or a retired date-format id maps to
  /// a value the controls can select. Other fields pass through.
  function normalize(p: Preferences): Preferences {
    if (p.line_spacing === "tight") p.line_spacing = "compact";
    if (p.line_spacing !== "compact" && p.line_spacing !== "standard") {
      p.line_spacing = "standard";
    }
    const knownDates = new Set<string>(DATE_FORMATS.map((f) => f.id));
    if (!knownDates.has(p.date_format)) {
      p.date_format = DATE_FORMATS[0]!.id;
    }
    return p;
  }

  function mutationPatch(
    current: Preferences,
    mutate: (preferences: Preferences) => Preferences,
  ): PreferencesPatch | null {
    const next = mutate(clone(current));
    const changed = Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(current[key as keyof Preferences]) !== JSON.stringify(value),
    );
    return changed.length > 0
      ? (Object.fromEntries(changed) as PreferencesPatch)
      : null;
  }

  async function reload(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const view = await api.config();
      lastServerSnap = JSON.stringify(view.preferences);
      editing = normalize(clone(view.preferences));
      loadError = null;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Refetch on every open transition so the surface always starts from
  // the current config, in every window type (workspace or standalone
  // terminal, where api.workspace() would 404 but api.config() works).
  let wasOpen = false;
  $effect(() => {
    const open = settingsPanel.open;
    if (open && !wasOpen) {
      void reload();
      void tick().then(() => {
        if (settingsPanel.open) settingsEl?.focus({ preventScroll: true });
      });
    } else if (!open && wasOpen) {
      void tick().then(() => {
        if (!settingsPanel.open) bumpTabFocusPulse();
      });
    }
    wasOpen = open;
  });

  // Cross-window live refresh. A sibling window's PATCH broadcasts
  // config_changed, which refreshes workspace.info.preferences; mirror
  // that into the buffer so the open form reflects it. Guarded on the
  // server snapshot (a content-identical reassign would churn the
  // $state proxy and re-fire this effect: Svelte 5's
  // effect_update_depth_exceeded) and skipped while a local write is in
  // flight so it can't revert an edit mid-round-trip.
  $effect(() => {
    const info = workspace.info;
    if (!settingsPanel.open || !info || inflight > 0) return;
    const snap = JSON.stringify(info.preferences);
    if (snap === lastServerSnap) return;
    lastServerSnap = snap;
    editing = normalize(clone(info.preferences));
  });

  // Live-apply the editor theme so it is already in place when the surface
  // closes. Other fields apply on the server refresh.
  $effect(() => {
    if (editing) {
      applyEditorTheme(editing.editor_theme);
      applyEditorFontSize(editing.editor_font_size);
    }
  });

  // This component stays mounted while Settings is closed, so server boot and
  // config_changed refreshes can apply the persisted override in every window.
  $effect(() => {
    applyEditorFontSize(currentPreferences()?.editor_font_size);
  });

  // Keep the editor-tools snapshot in sync so an open editor observes a
  // strip-on-save toggle immediately, before the round-trip.
  $effect(() => {
    if (editing) {
      editorToolsPrefs.stripTrailingWhitespaceOnSave =
        editing.strip_trailing_whitespace_on_save;
    }
  });

  /// Apply a single-field mutation. The optimistic local apply gives the
  /// control instant feedback; the persist runs through the shared
  /// revision/conflict-replay helper by default. A caller passes its own
  /// persist for a field with
  /// a dedicated store/api setter (theme). The write's config_changed
  /// then reconciles the buffer through the cross-window effect below,
  /// reflecting any server-side sanitization; the inflight counter holds
  /// that effect off until the write settles so it can't revert the
  /// optimistic value mid-round-trip.
  const commit: CommitFn = (mutate, persist) => {
    if (!editing) return;
    editing = normalize(mutate(clone(editing)));
    inflight++;
    const run = persist
      ? persist()
      : updateGlobalConfigSerial((prefs) => mutationPatch(prefs, mutate));
    void Promise.resolve(run).finally(() => {
      inflight--;
    });
  };

  // The rail is derived from the command registry's category set (see
  // settings/sections.ts): one section per surface, plus the Keyboard
  // Shortcuts meta section and the conditional per-workspace tab. "This
  // workspace" is shown only when Settings is opened from a workspace
  // context (workspace.info is null in a launcher / terminal-only
  // window). That conditional presence keeps the per-machine surface
  // device-global while giving the per-workspace controls a home scoped
  // to an active workspace.
  const sections = $derived(
    SETTINGS_SECTIONS.filter((s) => s.id !== "workspace" || workspace.info !== null),
  );
  let activeSection = $state<SettingsSectionId>("global");
  // If the workspace tab is active but the workspace goes away (or Settings is
  // reopened in a terminal-only window), fall back so the content pane never
  // points at a hidden tab. Converges: the reset makes the guard false.
  $effect(() => {
    if (activeSection === "workspace" && workspace.info === null) {
      activeSection = "global";
    }
  });

  function toggleMax(): void {
    setOverlayMaximized(!overlayMaximized.on);
  }

  function focusSection(index: number): void {
    const s = sections[index];
    if (!s) return;
    activeSection = s.id;
    void tick().then(() => {
      const buttons = sectionNavEl?.querySelectorAll<HTMLButtonElement>(".section-tab");
      buttons?.[index]?.focus({ preventScroll: true });
    });
  }

  function onSectionKeyDown(e: KeyboardEvent): void {
    const current = sections.findIndex((s) => s.id === activeSection);
    if (current < 0 || sections.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        focusSection((current + 1) % sections.length);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        focusSection((current - 1 + sections.length) % sections.length);
        break;
      case "Home":
        e.preventDefault();
        focusSection(0);
        break;
      case "End":
        e.preventDefault();
        focusSection(sections.length - 1);
        break;
    }
  }
</script>

<OverlayShell id="settings" open={settingsPanel.open} onClose={closeSettings}>
  <div class="settings" bind:this={settingsEl} tabindex="-1">
    <header>
      <button
        type="button"
        class="chrome-btn"
        onclick={toggleMax}
        title={overlayMaximized.on ? "Restore size" : "Maximize"}
        aria-label={overlayMaximized.on ? "Restore size" : "Maximize"}
      >
        {#if overlayMaximized.on}
          <Minimize2 size={14} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <Maximize2 size={14} strokeWidth={1.75} aria-hidden="true" />
        {/if}
      </button>
      <h2>Settings</h2>
      <button
        type="button"
        class="chrome-btn close"
        onclick={closeSettings}
        title="Close"
        aria-label="Close"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </header>
    <div class="body">
      <nav
        class="sections"
        aria-label="Settings sections"
        bind:this={sectionNavEl}
      >
        {#each sections as s (s.id)}
          {@const Icon = s.icon}
          <button
            type="button"
            class="section-tab"
            class:on={activeSection === s.id}
            aria-current={activeSection === s.id ? "page" : undefined}
            tabindex={activeSection === s.id ? 0 : -1}
            onkeydown={onSectionKeyDown}
            onclick={() => (activeSection = s.id)}
          >
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{s.label}</span>
          </button>
        {/each}
      </nav>
      <div class="content">
        {#if loadError}
          <div class="state">
            <p class="err">Could not load settings: {loadError}</p>
            <button type="button" class="retry" onclick={() => void reload()}>
              Retry
            </button>
          </div>
        {:else if !editing}
          <div class="state"><p>Loading settings...</p></div>
        {:else if activeSection === "shortcuts"}
          <!-- KeymapSettings owns its own filter + scrolling grid; it
               needs a sized flex-column container so its internal scroll
               is bounded to the overlay height. -->
          <div class="keymap-mount">
            <KeymapSettings />
          </div>
        {:else}
          <div class="section-scroll">
            {#if activeSection === "global"}
              <GlobalSection prefs={editing} {commit} />
            {:else if activeSection === "editor"}
              <EditorSection prefs={editing} {commit} />
            {:else if activeSection === "terminal"}
              <TerminalSection prefs={editing} {commit} />
            {:else if activeSection === "browser"}
              <BrowserSection prefs={editing} {commit} />
            {:else if activeSection === "graph"}
              <GraphSection prefs={editing} {commit} />
            {:else if activeSection === "dashboard"}
              <DashboardSection prefs={editing} {commit} />
            {:else if activeSection === "search"}
              <SearchSection prefs={editing} {commit} />
            {:else if activeSection === "workspace"}
              <WorkspaceSection />
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</OverlayShell>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  header h2 {
    flex: 1;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    text-align: center;
  }
  .chrome-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .chrome-btn:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .sections {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 200px;
    padding: 12px 8px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .section-tab {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    text-align: left;
  }
  .section-tab:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .section-tab.on {
    background: var(--hover-bg);
    color: var(--text);
    font-weight: 600;
  }
  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* Form sections scroll as a whole. */
  .section-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 24px 24px;
  }
  /* KeymapSettings owns its own filter row and scrolling grid, so it
     gets a bounded flex-column box instead of the section scroll. */
  .keymap-mount {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 24px;
    color: var(--text-secondary);
  }
  .err {
    margin: 0;
    color: var(--danger, #ef4444);
  }
  .retry {
    padding: 5px 12px;
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .retry:hover {
    border-color: var(--btn-hover);
  }
  /* Stack the section rail above the content on narrow viewports. */
  @media (max-width: 640px) {
    .body {
      flex-direction: column;
    }
    .sections {
      flex-direction: row;
      width: auto;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }
  }
</style>
