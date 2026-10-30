<!-- The control terminal's status view while its tmux control-mode
     connection runs: the connected tmux and its session, every window tmux
     listed with an Open action, the errors the connection kept, and Detach
     and End. It covers the terminal, which shows chan's notices alone while
     connected and takes no typing; it goes when the connection ends and the
     terminal draws again. Every attached client shows the same view. -->
<script lang="ts">
  import type { TmuxConnectionStatus, TmuxRequest, TmuxWindowStatus } from "../state/tmuxStatus";
  import { errorText } from "../api/errors";

  let {
    status,
    program,
    onRequest,
    onOpen,
  }: {
    status: TmuxConnectionStatus | null;
    /// The terminal's name, for the region's accessible name.
    program: string;
    onRequest: (request: TmuxRequest) => void;
    /// Open the chan window minted for a tmux window, by its id.
    onOpen: (chanWindowId: string) => Promise<void>;
  } = $props();

  // tmux windows asked to open and not yet minted: their chan window opens
  // as soon as the status carries it, so one click opens a window past the
  // cap.
  let awaiting = $state(new Set<string>());
  let confirmEnd = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    if (!status) {
      awaiting = new Set();
      confirmEnd = false;
      return;
    }
    for (const window of status.windows) {
      if (awaiting.has(window.id) && window.chan_window) {
        awaiting.delete(window.id);
        awaiting = new Set(awaiting);
        void show(window.chan_window);
      }
    }
  });

  async function show(chanWindowId: string): Promise<void> {
    failure = null;
    try {
      await onOpen(chanWindowId);
    } catch (error) {
      failure = `Could not open the window: ${errorText(error)}`;
    }
  }

  function open(window: TmuxWindowStatus): void {
    if (window.chan_window) {
      void show(window.chan_window);
      return;
    }
    awaiting = new Set([...awaiting, window.id]);
    if (!window.open) onRequest({ request: "open-window", window: window.id });
  }

  function label(window: TmuxWindowStatus): string {
    return window.name || window.id;
  }
</script>

{#if status}
  <div class="tmux-status" role="region" aria-label={`tmux control mode status for ${program}`}>
    <div class="ts-head">
      <strong>tmux {status.version}</strong> control mode
      {#if status.session}
        <span class="ts-session">session <b>{status.session.name}</b> <span class="ts-id">{status.session.id}</span></span>
      {/if}
    </div>
    {#if status.windows.length === 0}
      <p class="ts-empty">No windows yet.</p>
    {:else}
      <table class="ts-windows">
        <thead>
          <tr><th>Window</th><th class="ts-num">Panes</th><th></th></tr>
        </thead>
        <tbody>
          {#each status.windows as window (window.id)}
            <tr>
              <td><span class="ts-name">{label(window)}</span> <span class="ts-id">{window.id}</span></td>
              <td class="ts-num">{window.panes}</td>
              <td class="ts-act">
                {#if awaiting.has(window.id) && !window.chan_window}
                  <span class="ts-pending">Opening…</span>
                {:else}
                  <button class="ts-button" type="button" onclick={() => open(window)}>Open</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if status.windows.some((w) => !w.open)}
        <p class="ts-note">
          {status.window_cap} windows open at connect; Open brings in the rest.
        </p>
      {/if}
    {/if}
    {#if status.errors.length > 0}
      <ul class="ts-errors" aria-label="tmux connection errors">
        {#each status.errors as error, i (i)}
          <li>{error}</li>
        {/each}
      </ul>
    {/if}
    {#if failure}
      <p class="ts-failure" role="alert">{failure}</p>
    {/if}
    <div class="ts-actions">
      {#if confirmEnd}
        <span class="ts-confirm">End the tmux server and every session it holds?</span>
        <button class="ts-button ts-danger" type="button" onclick={() => { confirmEnd = false; onRequest({ request: "end" }); }}>End server</button>
        <button class="ts-button" type="button" onclick={() => (confirmEnd = false)}>Cancel</button>
      {:else}
        <button class="ts-button" type="button" onclick={() => onRequest({ request: "detach" })}>Detach</button>
        <button class="ts-button" type="button" onclick={() => (confirmEnd = true)}>End</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .tmux-status {
    position: absolute;
    inset: 0;
    z-index: 20;
    overflow: auto;
    padding: 0.8rem 1rem;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 0.85rem;
  }
  .ts-head {
    margin-bottom: 0.6rem;
    line-height: 1.4;
  }
  .ts-session {
    margin-left: 0.6rem;
    color: var(--text-secondary);
  }
  .ts-id {
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
  }
  .ts-windows {
    border-collapse: collapse;
    min-width: 20rem;
    max-width: 40rem;
  }
  .ts-windows th,
  .ts-windows td {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--separator);
    text-align: left;
    vertical-align: middle;
  }
  .ts-windows th {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .ts-num {
    text-align: right;
  }
  .ts-act {
    text-align: right;
    white-space: nowrap;
  }
  .ts-pending,
  .ts-note,
  .ts-empty {
    color: var(--text-secondary);
  }
  .ts-note,
  .ts-empty {
    margin: 0.5rem 0;
  }
  .ts-errors {
    margin: 0.6rem 0;
    padding-left: 1.2rem;
    color: var(--warn-text, var(--text));
    overflow-wrap: anywhere;
  }
  .ts-failure {
    margin: 0.4rem 0;
    color: var(--danger-text, var(--text));
  }
  .ts-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.8rem;
  }
  .ts-confirm {
    margin-right: 0.3rem;
  }
  .ts-button {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text);
    padding: 0.25rem 0.7rem;
    cursor: pointer;
  }
  .ts-danger {
    border-color: var(--danger-text, var(--border));
  }
</style>
