<script lang="ts">
  // The launcher root: the top bar over the machine-first library tree, with the
  // New/Edit dialog mounted while open. Data loads on mount and the tree stays
  // live through the window-watch subscription.
  import { onMount } from "svelte";
  import { RotateCw } from "@lucide/svelte";
  import TopBar from "./components/TopBar.svelte";
  import PlasmaBackground from "./components/PlasmaBackground.svelte";
  import { DEFAULT_WAVE_SPEED } from "./lib/plasmaBackground";
  import SelectionBar from "./components/SelectionBar.svelte";
  import ScreenFlip from "./components/ScreenFlip.svelte";
  import Library from "./components/Library.svelte";
  import Gateways from "./components/Gateways.svelte";
  import NewWorkspaceDialog from "./components/NewWorkspaceDialog.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import CommandLauncher from "./components/CommandLauncher.svelte";
  import Modal from "./components/Modal.svelte";
  import NoticeBubbles from "./components/NoticeBubbles.svelte";
  import { library, loadLibrary, reportError, resync } from "./state/library.svelte";
  import { pushNotice, type Notice } from "./state/notices.svelte";
  import { dialog } from "./state/dialog.svelte";
  import { confirm } from "./state/confirm.svelte";
  import { checksVisible } from "./state/selection.svelte";
  import { screen } from "./state/screen.svelte";
  import { onControlAttentionEvent, onControlRestoredEvent } from "./state/controlClosed.svelte";
  import {
    clearControlAttention,
    pruneControlAttention,
    resolvePendingControlAttention,
  } from "./state/controlAttention.svelte";
  import { hasTauriEvents, hideLauncherPanel, onTauriEvent, restartDesktopAfterUpdate } from "./api/desktop";
  import { activeCommandLauncherDraft } from "./state/commandLauncher.svelte";
  import { applyTheme, reconcileLocalTheme, watchLocalTheme } from "./state/theme.svelte";
  import { reconcileCollapsedMachines } from "./state/machineCollapse.svelte";
  import { hasDesktopBridge, readOnly } from "./state/capabilities";

  let { animatedBackground = true, waveSpeed = DEFAULT_WAVE_SPEED }: {
    animatedBackground?: boolean;
    waveSpeed?: number;
  } = $props();

  let updateReadyVersion: string | null = $state(null);
  let updateOpener: HTMLElement | null = $state(null);
  // Whether the update is already on disk (macOS, the Linux AppImage: it
  // applies on the next launch whatever the user picks) or only downloaded
  // and staged (Windows: the installer runs when the user restarts from here).
  let updateInstalled = $state(true);
  let updateRestarting = $state(false);
  let updateError: string | null = $state(null);

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat ||
      event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
      !hasDesktopBridge || !hasTauriEvents() || dialog.open || confirm.open ||
      updateReadyVersion || activeCommandLauncherDraft().visible) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable], form, [role=dialog]")) return;
    // An Add card can keep its form open while focus moves outside it. Forms
    // on inert, offscreen cards do not own the current screen's Escape.
    if ([...document.querySelectorAll(".form-face")].some((form) => !form.closest("[inert]"))) return;
    event.preventDefault();
    void hideLauncherPanel().catch((error) => console.warn("Returning to the pane failed", error));
  }

  type DesktopUpdateReadyPayload = {
    version: string;
    installed?: boolean;
  };

  function onDesktopUpdateReady(payload: DesktopUpdateReadyPayload): void {
    updateOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;
    updateReadyVersion = payload.version;
    updateInstalled = payload.installed ?? true;
    updateRestarting = false;
    updateError = null;
  }

  async function restartAfterUpdate(): Promise<void> {
    updateRestarting = true;
    updateError = null;
    try {
      await restartDesktopAfterUpdate();
    } catch (e) {
      updateRestarting = false;
      // A Tauri command's Err(String) rejects with the bare string, not an
      // Error (the Windows arm answers "no downloaded update is staged").
      updateError = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    applyTheme();
    // Reconcile the first-paint localStorage theme with the authoritative
    // desktop-config value, so a cleared WebView store or a second writer can
    // never leave the launcher and the local terminals on different themes.
    void reconcileLocalTheme();
    // Follow the desktop theme feed so a switch made in another desktop
    // window updates this Computers window immediately.
    const unwatchLocalTheme = hasDesktopBridge ? watchLocalTheme() : null;
    // Same reconcile for the per-machine collapse set: localStorage is a
    // first-paint cache, the desktop config is authoritative (a desktop restart
    // gets a fresh loopback origin, so localStorage alone cannot survive it).
    void reconcileCollapsedMachines();
    loadLibrary();
    // A connected devserver stopped answering while its control terminal is
    // still alive: flash that row for attention until the desktop reports the
    // connection responsive again. No-op off-desktop (the global Tauri event
    // bridge is absent in a browser).
    let unlistenAttention: (() => void) | null = null;
    let unlistenRestored: (() => void) | null = null;
    let unlistenUpdate: (() => void) | null = null;
    let unlistenAuthError: (() => void) | null = null;
    let unlistenAuthChanged: (() => void) | null = null;
    let unlistenNotice: (() => void) | null = null;
    void onTauriEvent("devserver-control-attention", onControlAttentionEvent).then((un) => {
      unlistenAttention = un;
    });
    void onTauriEvent("devserver-control-restored", onControlRestoredEvent).then((un) => {
      unlistenRestored = un;
    });
    void onTauriEvent<DesktopUpdateReadyPayload>(
      "desktop-update-ready",
      onDesktopUpdateReady,
    ).then((un) => {
      unlistenUpdate = un;
    });
    // Gateway sign-in narration. auth-error carries a display-ready string
    // (denied/cancelled sign-in, a failed resume connect, the sign-in
    // timeout) that reportError maps into an error notice; auth-changed fires
    // when a sign-in lands, so re-list the registries and the
    // waiting rows resolve without a reload.
    void onTauriEvent<string>("auth-error", reportError).then((un) => {
      unlistenAuthError = un;
    });
    void onTauriEvent("auth-changed", () => resync()).then((un) => {
      unlistenAuthChanged = un;
    });
    // Structured desktop narration (gateway/devserver cascades, migrations,
    // expiries): each payload is one corner bubble.
    void onTauriEvent<Notice>("launcher-notice", pushNotice).then((un) => {
      unlistenNotice = un;
    });
    return () => {
      unlistenAttention?.();
      unlistenRestored?.();
      unlistenUpdate?.();
      unlistenAuthError?.();
      unlistenAuthChanged?.();
      unlistenNotice?.();
      unwatchLocalTheme?.();
    };
  });

  // Clear a devserver's control-attention flash when it RECONNECTS (a
  // disconnected -> connected transition). Tracking the transition, not the
  // current state, avoids clearing the flash that the control-closed event just
  // set while the feed still reports the dying devserver as connected.
  const wasConnected = new Map<string, boolean>();
  $effect(() => {
    for (const ds of library.devservers) {
      const now = ds.status === "connected";
      const prev = wasConnected.get(ds.id);
      if (prev === false && now === true && ds.library_id) {
        clearControlAttention(ds.library_id);
      }
      wasConnected.set(ds.id, now);
    }
    resolvePendingControlAttention();
    // Drop flags whose control terminal has left the feed (closed / reaped /
    // torn-down), so a dead lib does not leak a flag or stale-flash on a
    // same-lib reconnect. Reads `library.windows`, so this pass re-runs on any
    // feed change.
    pruneControlAttention();
  });
</script>

<svelte:window onkeydown={onEscape} />

{#if animatedBackground}<PlasmaBackground speed={waveSpeed} />{/if}
<div class="launcher-surface" inert={dialog.open || confirm.open || !!updateReadyVersion}>
  <TopBar />

  <main
    class="content"
    class:with-bulk-bar={!readOnly && checksVisible()}
    class:deck={hasDesktopBridge}>
    <ScreenFlip
      transparent={animatedBackground}
      flips={screen.flips}
      backLabel={screen.current === "computers" ? "Computers" : "Gateways"}>
      {#if screen.current === "computers"}
        <Library />
      {:else}
        <Gateways />
      {/if}
    </ScreenFlip>
  </main>

  {#if !readOnly}
    <SelectionBar />
  {/if}

  {#if !readOnly}
    <CommandLauncher />
  {/if}
</div>

{#if dialog.open}
  <NewWorkspaceDialog />
{/if}

{#if confirm.open}
  <ConfirmDialog />
{/if}

{#if updateReadyVersion}
  <Modal title="Update ready" onclose={() => (updateReadyVersion = null)} returnFocus={updateOpener}>
    <p class="update-copy">
      {#if updateInstalled}
        chan-desktop {updateReadyVersion} has been downloaded and will apply on the next launch.
      {:else}
        chan-desktop {updateReadyVersion} has been downloaded. Restart now to install it.
      {/if}
    </p>
    {#if updateError}
      <p class="update-error" role="alert">{updateError}</p>
    {/if}
    <div class="update-actions">
      <button
        class="btn secondary"
        type="button"
        onclick={() => (updateReadyVersion = null)}
        disabled={updateRestarting}
      >
        Later
      </button>
      <button
        class="btn primary"
        type="button"
        onclick={() => void restartAfterUpdate()}
        disabled={updateRestarting}
      >
        <RotateCw size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>{updateRestarting ? "Restarting..." : "Restart"}</span>
      </button>
    </div>
  </Modal>
{/if}

<NoticeBubbles />

<style>
  .launcher-surface {
    display: contents;
  }

  .content {
    max-width: 44rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
  }

  /* In select mode the bottom-docked bulk bar overlays the viewport; extra
     bottom padding keeps the last rows clear of it. */
  .content.with-bulk-bar {
    padding-bottom: 6rem;
  }

  /* The desktop's Computers and Gateways decks span the window so the side
     cards of the carousel show beside the one in front. */
  .content.deck {
    max-width: none;
    padding: 0.75rem 0 1rem;
  }

  .update-copy {
    margin: 0;
    color: var(--text);
    line-height: 1.45;
  }

  .update-error {
    margin: 0.85rem 0 0;
    padding: 0.55rem 0.65rem;
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 0.88rem;
  }

  .update-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1.1rem;
  }

  .update-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-height: 2.1rem;
    font-family: inherit;
  }
</style>
