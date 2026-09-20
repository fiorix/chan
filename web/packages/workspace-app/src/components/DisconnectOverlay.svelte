<script lang="ts">
  // Full-app overlay surfaced when the watcher channel drops. The
  // watcher is the only push channel between the server and the UI;
  // without it, file changes from outside the editor stop
  // propagating, so silently letting the user keep typing risks
  // divergence between the buffer and disk.
  //
  // The overlay greys out the entire UI and reads as a live
  // reconnecting state: a spinner + status. The auto-reconnect loop
  // runs underneath, so doing nothing heals on its own once the
  // channel returns. A devserver-backed desktop window also offers a
  // single Abandon action to give up on a stuck remote connection.

  import { setCoverBlocking, ui } from "../state/store.svelte";
  import { windowLibraryId } from "../api/client";
  import {
    isTauriDesktop,
    abandonDevserverForWindow,
    reconnectDevserverForWindow,
  } from "../api/desktop";
  import { onDestroy } from "svelte";

  // Recovery actions (Reconnect / Abandon) are offered only on a devserver-backed
  // desktop window: a stuck remote connection the user can force back or give up
  // on. windowLibraryId() is "local" for the local library; isTauriDesktop()
  // gates out the plain browser (which has no IPC and whose tab the user closes
  // themselves). Both read once -- not reactive.
  const canRecover = isTauriDesktop() && windowLibraryId() !== "local";
  let reconnectBtn: HTMLButtonElement | null = $state(null);
  let abandonBtn: HTMLButtonElement | null = $state(null);
  let pendingAction = $state<"reconnect" | "abandon" | null>(null);
  let recoveryError = $state<string | null>(null);

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function runRecovery(
    action: "reconnect" | "abandon",
    fn: () => Promise<void>,
  ): Promise<void> {
    if (pendingAction !== null) return;
    pendingAction = action;
    recoveryError = null;
    try {
      await fn();
    } catch (e) {
      recoveryError = errorText(e);
    } finally {
      pendingAction = null;
    }
  }

  // Reconnect: ask the desktop to force-close the dead control terminal and
  // re-run the connect flow. Failures stay visible so the user can distinguish a
  // live retry from an IPC/ACL refusal.
  function reconnect(): void {
    void runRecovery("reconnect", reconnectDevserverForWindow);
  }

  // Abandon: ask the desktop to disconnect this window's devserver. The window
  // closes async via the watcher. Failures stay visible instead of silently
  // leaving the overlay in the same state.
  function abandon(): void {
    void runRecovery("abandon", abandonDevserverForWindow);
  }

  /// Show the overlay only AFTER the watcher channel has been open
  /// at least once during this session. The "connecting" state at
  /// app boot is unbounded in length: on slow networks it can take
  /// several seconds. Blocking the UI during cold boot would make
  /// the app appear unresponsive ("nothing clicks") with no useful
  /// signal to the user.
  ///
  /// Once we've seen "open" once, any later transition to a
  /// non-open state is a real disconnect that's worth surfacing -
  /// file changes won't propagate, autosave can't reach the server,
  /// etc. A 600 ms grace still hides the overlay through brief
  /// reconnects.
  ///
  /// Done with an $effect that owns the timer rather than a $derived
  /// computing on Date.now: $derived must be pure, and recording
  /// state transitions is a side effect.
  const STARTUP_GRACE_MS = 600;
  let visible = $state(false);
  let hasBeenOpen = $state(false);
  let overlayEl: HTMLDivElement | null = $state(null);

  // Mirror `visible` into the shared store so App.svelte's document-level
  // key handlers can suppress pane/tab shortcuts while the overlay blocks
  // the UI (the backdrop stops clicks, but not keystrokes). Reset on teardown
  // so a stale `true` can't outlive the overlay.
  $effect(() => {
    ui.disconnectBlocking = visible;
    setCoverBlocking("reconnect", visible);
  });
  onDestroy(() => {
    ui.disconnectBlocking = false;
    setCoverBlocking("reconnect", false);
  });

  $effect(() => {
    if (ui.ws === "open") {
      hasBeenOpen = true;
      visible = false;
      pendingAction = null;
      recoveryError = null;
      return;
    }
    if (!hasBeenOpen) {
      // Cold boot still in progress. Stay invisible so the user
      // can interact with the app while the watcher catches up.
      visible = false;
      return;
    }
    const t = setTimeout(() => {
      visible = true;
    }, STARTUP_GRACE_MS);
    return () => clearTimeout(t);
  });

  /// Steal focus when the overlay appears. The backdrop's
  /// pointer-events stop *clicks* from reaching the editor, but
  /// keystrokes still flow to whatever was focused before the
  /// disconnect (typically the WYSIWYG / CodeMirror surface), so a
  /// user mid-edit could keep typing into a buffer the watcher
  /// can't observe. Park focus on the primary Reconnect button when
  /// it's offered (else Abandon, else the overlay). Paired with the
  /// keydown trap below, Tab can't leak focus back to the background.
  $effect(() => {
    if (!visible) return;
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
    queueMicrotask(() => (reconnectBtn ?? abandonBtn ?? overlayEl)?.focus());
  });

  function trapTab(e: KeyboardEvent): void {
    // Keep focus on the dialog: Tab/Shift+Tab cycles between the recovery
    // buttons and never leaks to the blocked UI behind. With no buttons (the
    // overlay is status-only), focus stays on the overlay.
    if (e.key !== "Tab") return;
    e.preventDefault();
    if (!reconnectBtn && !abandonBtn) return;
    const onReconnect = document.activeElement === reconnectBtn;
    (onReconnect ? abandonBtn : reconnectBtn)?.focus();
  }

  // "closed" is never emitted by the transport (it pushes connecting /
  // open / reconnecting only), so the visible overlay is always a
  // reconnect in progress; "connecting" is the transient retry-attempt
  // state, anything else reads as reconnecting.
  const message = $derived(
    ui.ws === "connecting"
      ? "connecting to the chan server"
      : "reconnecting to the chan server",
  );

  // Live elapsed timer + attempt counter, matching the desktop connecting
  // screen's retry presentation. The timer runs only while the overlay is up
  // (it resets on each disconnect); the attempt count rides `ui.wsAttempt`,
  // surfaced by the watcher transport.
  let elapsedMs = $state(0);
  $effect(() => {
    if (!visible) {
      elapsedMs = 0;
      return;
    }
    const start = Date.now();
    elapsedMs = 0;
    const id = setInterval(() => {
      elapsedMs = Date.now() - start;
    }, 1000);
    return () => clearInterval(id);
  });

  function fmtElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  const meta = $derived(
    ui.wsAttempt > 0
      ? `attempt ${ui.wsAttempt} · ${fmtElapsed(elapsedMs)}`
      : fmtElapsed(elapsedMs),
  );
</script>

{#if visible}
  <div
    class="overlay"
    role="alertdialog"
    aria-modal="true"
    aria-live="assertive"
    aria-label={message}
    tabindex="-1"
    bind:this={overlayEl}
    onkeydown={trapTab}
  >
    <div class="card">
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">{message}</div>
      <div class="meta" aria-live="polite">{meta}</div>
      {#if recoveryError}
        <div class="error" role="alert">{recoveryError}</div>
      {/if}
      {#if canRecover}
        <div class="actions">
          <button
            class="reconnect"
            bind:this={reconnectBtn}
            disabled={pendingAction !== null}
            onclick={reconnect}
          >
            {pendingAction === "reconnect" ? "Reconnecting..." : "Reconnect"}
          </button>
          <button
            class="abandon"
            bind:this={abandonBtn}
            disabled={pendingAction !== null}
            onclick={abandon}
          >
            {pendingAction === "abandon" ? "Abandoning..." : "Abandon"}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Cover the entire viewport with a semi-opaque backdrop so the
     UI underneath visibly greys out. Pointer-events on so clicks
     don't reach controls behind. */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30000;
    backdrop-filter: blur(2px);
  }
  .card {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5);
    padding: 18px 22px;
    max-width: 420px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  /* Reconnecting indicator: a quiet ring spinner so the overlay reads
     as an active wait, not a dead error. Static under reduced motion. */
  .spinner {
    width: 28px;
    height: 28px;
    align-self: center;
    margin-bottom: 2px;
    border: 3px solid var(--border);
    border-top-color: var(--link);
    border-radius: 50%;
    animation: disconnect-spin 0.9s linear infinite;
  }
  @keyframes disconnect-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  .title {
    font-size: 16px;
    font-weight: 600;
  }
  /* Attempt counter + elapsed timer, mirroring the desktop connecting
     screen's retry readout. Tabular figures so the seconds don't jitter. */
  .meta {
    font-size: 13px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .error {
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 45%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
    color: var(--danger, #ef4444);
    font-size: 13px;
    line-height: 1.35;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  /* Reconnect is the primary recovery action: a filled accent button. */
  .reconnect {
    background: var(--accent, var(--link));
    color: var(--bg);
    border: 1px solid var(--accent, var(--link));
    border-radius: 4px;
    padding: 6px 14px;
    font: inherit;
    cursor: pointer;
  }
  .reconnect:hover {
    filter: brightness(1.08);
  }
  /* Abandon is the destructive escape hatch: muted until hover, then danger. */
  .abandon {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 14px;
    font: inherit;
    cursor: pointer;
  }
  .abandon:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
  .actions button:disabled {
    cursor: wait;
    opacity: 0.62;
  }
</style>
