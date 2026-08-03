<script lang="ts">
  // The launcher root: the top bar over the machine-first library tree, with the
  // New/Edit dialog mounted while open. Data loads on mount and the tree stays
  // live through the window-watch subscription.
  import { onMount } from "svelte";
  import { RotateCw } from "lucide-svelte";
  import TopBar from "./components/TopBar.svelte";
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
  import { onTauriEvent, restartDesktopAfterUpdate } from "./api/desktop";
  import { applyTheme, reconcileLocalTheme, watchLocalTheme } from "./state/theme.svelte";
  import { reconcileCollapsedMachines } from "./state/machineCollapse.svelte";
  import { hasDesktopBridge, readOnly } from "./state/capabilities";

  let updateReadyVersion: string | null = $state(null);
  let updateRestarting = $state(false);
  let updateError: string | null = $state(null);

  type DesktopUpdateReadyPayload = {
    version: string;
  };

  function onDesktopUpdateReady(payload: DesktopUpdateReadyPayload): void {
    updateReadyVersion = payload.version;
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
      updateError = (e as Error).message;
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
    // when a sign-in lands or is cleared, so re-list the registries and the
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

<TopBar />

<main class="content" class:with-bulk-bar={!readOnly && checksVisible()}>
  <ScreenFlip
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

<NoticeBubbles />

{#if !readOnly}
  <CommandLauncher />
{/if}

{#if dialog.open}
  <NewWorkspaceDialog />
{/if}

{#if confirm.open}
  <ConfirmDialog />
{/if}

{#if updateReadyVersion}
  <Modal title="Update ready" onclose={() => (updateReadyVersion = null)}>
    <p class="update-copy">
      chan-desktop {updateReadyVersion} has been downloaded and will apply on the next launch.
    </p>
    {#if updateError}
      <p class="update-error" role="alert">{updateError}</p>
    {/if}
    <div class="update-actions">
      <button
        class="secondary"
        type="button"
        onclick={() => (updateReadyVersion = null)}
        disabled={updateRestarting}
      >
        Later
      </button>
      <button
        class="primary"
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

<style>
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
    padding: 0 0.85rem;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }

  .update-actions button:disabled {
    cursor: progress;
    opacity: 0.65;
  }

  .update-actions .secondary {
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-secondary);
  }

  .update-actions .primary {
    border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
    background: var(--accent);
    color: #fff;
  }
</style>
