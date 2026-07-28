<!-- Survey overlay for `cs terminal survey`.

     Renders ONE survey slot (per-terminal): a markdown problem
     body, up to 4 vertically aligned numbered options, and (standard on
     EVERY survey) an [F] follow-up plus a Dismiss. Picking an option (click or
     1..N), [F] (click or F), or Dismiss (click, X, or Escape) POSTs the reply,
     which unblocks the waiting CLI. The overlay is modal over its slot; the CLI
     is blocked on the reply, so the three exits are option / followup /
     dismissed - all real replies, no silent close that could hang the CLI.

     `tabId` selects the slot: a terminal tab id => render PER-TERMINAL, anchored
     over THAT terminal only (mounted inside its TerminalTab), so two terminals
     show independent surveys and the rest of the window stays usable. `null` =>
     the window-wide fallback (a centered modal over the whole window), mounted
     once at the App root for surveys with no resolvable target. -->
<script lang="ts">
  import { renderMarkdownWithBreaks } from "../api/markdown";
  import {
    surveyFor,
    surveyBusy,
    pickOption,
    requestFollowup,
    dismissSurvey,
    type SurveySlot,
  } from "../state/survey.svelte";

  let { tabId = null }: { tabId?: SurveySlot } = $props();

  const slot = $derived(tabId);
  const active = $derived(surveyFor(slot));
  const busy = $derived(surveyBusy(slot));

  // Steal focus to the card when this slot's survey appears so option/F keys
  // land here and not in the terminal/editor underneath. Blur immediately,
  // then focus after the current flush so a terminal's already-queued refocus
  // cannot take the keyboard back. Keyed on surveyId so a replacing survey
  // re-focuses.
  let card = $state<HTMLDivElement | null>(null);
  let returnFocus: HTMLElement | null = null;
  let focusedSurveyId: string | null = null;
  $effect(() => {
    const id = active?.surveyId ?? null;
    if (!id) {
      if (!focusedSurveyId) return;
      focusedSurveyId = null;
      const target = returnFocus;
      returnFocus = null;
      queueMicrotask(() => {
        if (!active && target?.isConnected) target.focus({ preventScroll: true });
      });
      return;
    }
    if (!focusedSurveyId) {
      const current = document.activeElement;
      returnFocus =
        current instanceof HTMLElement && current !== document.body ? current : null;
    }
    focusedSurveyId = id;
    (document.activeElement as HTMLElement | null)?.blur();
    queueMicrotask(() => {
      if (active?.surveyId === id) card?.focus({ preventScroll: true });
    });
  });

  // Number keys 1..N pick an option; F follows up; X or Escape dismisses. F
  // and X/Escape are standard on every survey. Scoped to the focused
  // card (NOT the window) so each terminal's survey handles its own keys, a
  // focused terminal does not swallow the keystroke into its PTY, and a handled
  // Escape does not bubble out to close other overlays.
  function onCardKeydown(e: KeyboardEvent): void {
    const s = active;
    if (!s) return;
    if (e.key >= "1" && e.key <= "9") {
      const idx = Number(e.key) - 1;
      if (idx < s.options.length) {
        e.preventDefault();
        e.stopPropagation();
        void pickOption(slot, idx);
      }
      return;
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      e.stopPropagation();
      void requestFollowup(slot);
      return;
    }
    if (e.key === "x" || e.key === "X" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void dismissSurvey(slot);
    }
  }
</script>

{#if active}
  <div
    class="survey-overlay"
    class:per-terminal={slot !== null}
    role="dialog"
    aria-modal="true"
  >
    <!-- The card is the focusable survey surface (tabindex -1, focused on
         appear); its keydown is the 1..N / F / X shortcut handler, scoped here
         rather than the window so each terminal's survey owns its own keys. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="survey-card"
      tabindex="-1"
      bind:this={card}
      onkeydown={onCardKeydown}
    >
      {#if active.title}
        <h2 class="survey-title">{active.title}</h2>
      {/if}
      <!-- renderMarkdownWithBreaks is DOMPurify-sanitized (web/packages/workspace-app/src/api/markdown.ts),
           so {@html} is safe for the agent-supplied body. `breaks: true` so a
           single authored newline renders as a line break (survey bodies are
           hand-written multi-line prompts). -->
      <div class="survey-body">{@html renderMarkdownWithBreaks(active.bodyMarkdown)}</div>
      <ul class="survey-options">
        {#each active.options as option, i (i)}
          <li>
            <button
              type="button"
              class="survey-option"
              disabled={busy}
              onclick={() => pickOption(slot, i)}
            >
              <span class="survey-option-key">{i + 1}</span>
              <span class="survey-option-label">{option}</span>
            </button>
          </li>
        {/each}
      </ul>
      <!-- F (follow up) + Dismiss are standard on every survey (not an
           opt-in). F defers with a paper-trail file; Dismiss sends a
           distinct "dismissed" reply (no file) so the asking agent can tell the
           host dropped it. -->
      <div class="survey-actions">
        <button
          type="button"
          class="survey-followup"
          disabled={busy}
          onclick={() => requestFollowup(slot)}
        >
          [F] Follow up later
        </button>
        <button
          type="button"
          class="survey-dismiss"
          disabled={busy}
          onclick={() => dismissSurvey(slot)}
        >
          [X] Dismiss
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .survey-overlay {
    position: fixed;
    inset: 0;
    z-index: 39000;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  /* Per-terminal: cover only the owning terminal (the .terminal-tab is the
     position:relative context), so the survey sits over its own terminal and
     other terminals stay usable. Below the terminal menu bubble (z 25500) but
     above the xterm canvas. */
  .survey-overlay.per-terminal {
    position: absolute;
    z-index: 24000;
    /* 5% border all around the owning terminal: the card fills the padded
       area below (~90% of the pane on every side), not a narrow 520px widget. */
    padding: 5%;
  }
  .survey-card {
    width: min(520px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    padding: 1.25rem 1.5rem;
    box-sizing: border-box;
    outline: none;
  }
  .per-terminal .survey-card {
    /* Fill the 5%-padded overlay (~90% of the pane); drop the 520px cap so
       it's the wide panel, not a centered narrow widget. Content scrolls
       (overflow-y on .survey-card) when the body is long. */
    width: 100%;
    max-height: 100%;
  }
  .survey-title {
    margin: 0 0 0.75rem;
    font-size: 16px;
    font-weight: 600;
  }
  .survey-body {
    font-size: 16px;
    line-height: 1.5;
    margin-bottom: 1rem;
  }
  .survey-body :global(p) {
    margin: 0 0 0.6rem;
  }
  .survey-body :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
  }
  .survey-options {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .survey-option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    padding: 0.6rem 0.75rem;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    cursor: pointer;
    font-size: 15px;
  }
  .survey-option:hover:not(:disabled),
  .survey-option:focus-visible {
    border-color: var(--text);
  }
  .survey-option:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .survey-option-key {
    flex: 0 0 auto;
    min-width: 1.4em;
    height: 1.4em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .survey-option-label {
    flex: 1 1 auto;
  }
  /* Actions row: [F] follow-up (dashed = soft defer, takes the width)
     and Dismiss (solid = firm drop, sits on the right). */
  .survey-actions {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }
  .survey-followup {
    flex: 1 1 auto;
    padding: 0.5rem 0.75rem;
    background: transparent;
    color: var(--text-secondary);
    border: 1px dashed var(--border);
    border-radius: 7px;
    cursor: pointer;
    font-size: 13px;
  }
  .survey-followup:hover:not(:disabled),
  .survey-followup:focus-visible {
    color: var(--text);
    border-color: var(--text);
  }
  .survey-followup:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .survey-dismiss {
    flex: 0 0 auto;
    padding: 0.5rem 0.9rem;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 7px;
    cursor: pointer;
    font-size: 13px;
  }
  .survey-dismiss:hover:not(:disabled),
  .survey-dismiss:focus-visible {
    color: var(--text);
    border-color: var(--text);
  }
  .survey-dismiss:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
