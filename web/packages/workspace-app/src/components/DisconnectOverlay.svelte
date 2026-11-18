<script lang="ts">
  import PrivateField from "@chan/web-shared/PrivateField.svelte";
  // Full-app overlay surfaced when the watcher channel drops. The
  // watcher is the only push channel between the server and the UI;
  // without it, file changes from outside the editor stop
  // propagating, so silently letting the user keep typing risks
  // divergence between the buffer and disk.
  //
  // The overlay greys out the app, starting below an available title band,
  // and reads as a live reconnecting state: a spinner + status. The auto-reconnect loop
  // runs underneath, so doing nothing heals on its own once the
  // channel returns. A devserver-backed desktop window also offers a
  // Restart connection and Abandon actions for a stuck remote connection.

  import { COVER_ROOT_ATTR, modalDialogOpen, setCoverBlocking, ui } from "../state/store.svelte";
  import { windowLibraryId } from "../api/client";
  import {
    isTauriDesktop,
    abandonDevserverForWindow,
    reconnectDevserverForWindow,
  } from "../api/desktop";
  import { errorText } from "../api/errors";
  import { keyboardOwnedAbovePanes, launcherShownOverWindow, mayFocus } from "../state/keyboardOwner.svelte";
  import { bumpTabFocusPulse } from "../state/tabs.svelte";
  import { connectionHealth } from "../state/connectionHealth.svelte";
  import { windowTabBar } from "../state/windowTabBar.svelte";
  import { onDestroy, onMount, tick, untrack } from "svelte";

  // Recovery actions (Restart connection / Abandon) are offered only on a devserver-backed
  // desktop window: a stuck remote connection the user can force back or give up
  // on. windowLibraryId() is "local" for the local library; isTauriDesktop()
  // gates out the plain browser (which has no IPC and whose tab the user closes
  // themselves). Both read once -- not reactive.
  const canRecover = isTauriDesktop() && windowLibraryId() !== "local";
  let reconnectBtn: HTMLButtonElement | null = $state(null);
  let abandonBtn: HTMLButtonElement | null = $state(null);
  let pendingAction = $state<"reconnect" | "abandon" | null>(null);
  let recoveryError = $state<string | null>(null);
  // Only a button the user activated may regain focus after its IPC settles.
  let focusAfterAction: "reconnect" | "abandon" | null = null;
  // A late IPC completion cannot return focus during a later outage.
  let recoveryEpoch = 0;
  type FocusReturn = { element: HTMLElement; surface: boolean };
  // Keep the surface kind because reconnect can replace its focused DOM node.
  let focusBeforeCover: FocusReturn | null = null;
  // Computers owns the first responder; carry this until it hides or a newer owner wins.
  let deferredFocus: { returnTo: FocusReturn; epoch: number } | null = null;
  const restartNoteId = $props.id();

  async function runRecovery(
    action: "reconnect" | "abandon",
    fn: () => Promise<void>,
  ): Promise<void> {
    if (pendingAction !== null) return;
    const actionEpoch = recoveryEpoch;
    pendingAction = action;
    recoveryError = null;
    try {
      await fn();
    } catch (e) {
      if (recoveryEpoch === actionEpoch) recoveryError = errorText(e);
    } finally {
      if (recoveryEpoch === actionEpoch) pendingAction = null;
      await tick();
      // Disabling the active button can drop native focus onto the body.
      if (visible && !outageResolved && recoveryEpoch === actionEpoch) {
        focusAfterAction = action;
        focusCard(action === "reconnect" ? reconnectBtn : abandonBtn);
      }
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
  /// Once we've seen "open" once, a lost watcher can surface a cover.
  /// The outage's first loss decides its due time; a pong ends it.
  ///
  /// Done with an $effect that owns the timer rather than a $derived
  /// computing on Date.now: $derived must be pure, and recording
  /// state transitions is a side effect.
  const STARTUP_GRACE_MS = 600;
  // Native recovery disrupts every window; let the page's redial try first.
  const RECOVERY_ACTION_DELAY_MS = 8_000;
  let visible = $state(false);
  let actionsReady = $state(false);
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
  onMount(() => {
    // A launcher hide is the first point at which the page may take focus back.
    const onWindowFocus = (): void => {
      if (!deferredFocus || launcherShownOverWindow() || !outageResolved) return;
      const { returnTo, epoch } = deferredFocus;
      deferredFocus = null;
      restoreFocus(returnTo, epoch);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  });

  const outageResolved = $derived(ui.ws === "open" && connectionHealth.outage === null);
  const bandAvailable = $derived(windowTabBar.on && !keyboardOwnedAbovePanes());
  $effect(() => {
    // Each watcher status change restarts the grace timer for a closed socket.
    const status = ui.ws;
    if (status === "open" && outageResolved) {
      recoveryEpoch += 1;
      const priorFocus = focusBeforeCover ?? deferredFocus?.returnTo ?? null;
      focusBeforeCover = null;
      deferredFocus = null;
      hasBeenOpen = true;
      visible = false;
      pendingAction = null;
      recoveryError = null;
      focusAfterAction = null;
      if (priorFocus) {
        const epoch = recoveryEpoch;
        void tick().then(() => restoreFocus(priorFocus, epoch));
      }
      return;
    }
    if (!hasBeenOpen) {
      // Cold boot still in progress. Stay invisible so the user
      // can interact with the app while the watcher catches up.
      visible = false;
      return;
    }
    // Only direct status changes without the connection-state bridge, as in tests,
    // lack an outage deadline.
    const coverAt = connectionHealth.outage?.coverAt ?? Date.now();
    const show = setTimeout(() => {
      visible = true;
    }, Math.max(STARTUP_GRACE_MS, coverAt - Date.now()));
    return () => clearTimeout(show);
  });

  $effect(() => {
    if (outageResolved || !hasBeenOpen) {
      actionsReady = false;
      return;
    }
    const actions = setTimeout(() => {
      actionsReady = true;
    }, RECOVERY_ACTION_DELAY_MS);
    return () => clearTimeout(actions);
  });

  /// Park focus when the overlay appears. The backdrop's
  /// pointer-events stop *clicks* from reaching the editor, but
  /// keystrokes still flow to whatever was focused before the
  /// disconnect (typically the WYSIWYG / CodeMirror surface), so a
  /// user mid-edit could keep typing into a buffer the watcher
  /// can't observe. Park focus on the overlay until the user tabs
  /// to an action. Paired with the
  /// keydown trap below, Tab can't leak focus back to the background.
  ///
  /// chan-desktop can show the Computers launcher over this window while the
  /// overlay is up, and the launcher holds the window's keyboard: a focus()
  /// here would make this page the first responder again and leave the
  /// launcher deaf. So the card takes focus only while no launcher is shown,
  /// and the page's window focus event, which fires when the launcher hides
  /// or the window comes back, returns focus to the card if it left every
  /// cover in the meantime. A cover over this one, such as the screen lock,
  /// keeps its own focus.
  $effect(() => {
    if (!visible) return;
    const dialogOpen = modalDialogOpen();
    const active = document.activeElement as HTMLElement | null;
    // An owner that paints over this cover (the close prompt) holds the
    // keyboard over it, and its element is not the one to return to. A
    // dialog closing runs this again, and the card takes the keyboard.
    if (untrack(() => mayFocus(active))) return;
    if (active && active !== document.body && active !== document.documentElement && !active.closest(`[${COVER_ROOT_ATTR}]`)) {
      focusBeforeCover = { element: active, surface: !!active.closest(".terminal-host, .editor-host") };
      deferredFocus = null;
    } else if (!focusBeforeCover && deferredFocus && (!active || active === document.body || active === document.documentElement)) {
      focusBeforeCover = deferredFocus.returnTo;
      deferredFocus = null;
    }
    // ModalShell repairs focus into its top dialog. Leave that keyboard owner
    // alone throughout the cover and after it clears.
    if (dialogOpen && active?.closest('.modal[role="dialog"]')) return;
    active?.blur();
    queueMicrotask(() => {
      if (!mayFocus(document.activeElement)) focusCard();
    });
    const onWindowFocus = (): void => {
      const holder = document.activeElement;
      if (!holder?.closest(`[${COVER_ROOT_ATTR}]`) && !mayFocus(holder)) focusCard();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  });

  function restoreFocus(returnTo: FocusReturn, epoch: number): void {
    if (recoveryEpoch !== epoch || !outageResolved) return;
    if (launcherShownOverWindow()) {
      deferredFocus = { returnTo, epoch };
      return;
    }
    const saved = returnTo.element;
    if (!mayFocus(saved)) return;
    const holder = document.activeElement;
    if (holder !== document.body && holder !== document.documentElement && !holder?.closest(`[${COVER_ROOT_ATTR}="reconnect"]`)) return;
    // The tab pulse invokes the terminal or editor's own focus routine, which
    // re-arms its real keyboard surface and cursor after the cover has gone.
    if (returnTo.surface) bumpTabFocusPulse();
    else if (saved.isConnected) saved.focus({ preventScroll: true });
  }

  function focusCard(preferred: HTMLElement | null = null): void {
    if (launcherShownOverWindow()) return;
    const action = focusAfterAction === "reconnect"
      ? reconnectBtn
      : focusAfterAction === "abandon" ? abandonBtn : null;
    (preferred ?? action ?? overlayEl)?.focus();
  }

  function trapTab(e: KeyboardEvent): void {
    // Keep focus on the dialog: Tab/Shift+Tab cycles between the recovery
    // buttons and never leaks to the blocked UI behind. With no buttons (the
    // overlay is status-only), focus stays on the overlay.
    if (e.key !== "Tab") return;
    e.preventDefault();
    const controls = Array.from(overlayEl?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!controls.length) return;
    const current = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = current < 0 ? (e.shiftKey ? controls.length - 1 : 0) : (current + (e.shiftKey ? controls.length - 1 : 1)) % controls.length;
    controls[next]?.focus();
  }

  // Every status shown after an earlier open belongs to the same reconnect.
  const message = "reconnecting to the chan server";

  // Live elapsed timer + attempt counter, matching the desktop connecting
  // screen's retry presentation. The timer displays time since the outage
  // began; the attempt count rides `ui.wsAttempt`,
  // surfaced by the watcher transport.
  let elapsedMs = $state(0);
  $effect(() => {
    if (!visible) {
      elapsedMs = 0;
      return;
    }
    // Direct status changes without the connection-state bridge have no outage start.
    const start = connectionHealth.outage?.startedAt ?? Date.now();
    elapsedMs = Date.now() - start;
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
    style:top={bandAvailable ? `${windowTabBar.height}px` : "0px"}
    data-cover="reconnect"
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
        <div class="error" role="alert"><PrivateField field="reconnect:error" label="reconnection error">{recoveryError}</PrivateField></div>
      {/if}
      {#if canRecover && actionsReady}
        <div class="actions">
          <button
            class="reconnect"
            bind:this={reconnectBtn}
            aria-describedby={restartNoteId}
            disabled={pendingAction !== null}
            onclick={reconnect}
          >
            {pendingAction === "reconnect" ? "Restarting..." : "Restart connection"}
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
        <div class="action-note" id={restartNoteId}>Restart closes and reopens the windows served by this connection.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* An available title band stays outside the cover; otherwise the inline
     top leaves the whole viewport blocked. */
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
  .overlay:focus { outline: none; }
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
  .action-note {
    color: var(--text-secondary);
    font-size: 12px;
  }
  /* Restart is the primary recovery action: a filled accent button. */
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
