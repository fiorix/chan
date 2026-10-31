<!-- The question a terminal shows when a program other than a local tmux
     printed the tmux control-mode marker: the foreground program is named,
     and the user, who ran the command, says whether it is a tmux of theirs.
     Nothing is written to the terminal until it is answered; the server
     denies by itself after its timeout. Every attached client shows the same
     banner and the first answer wins, so an answer here is sent once and the
     banner goes when the server says the question is closed. -->
<script lang="ts">
  import type { TmuxAnswer, TmuxQuestion } from "../state/tmuxConsent";
  import { createCardFocus } from "./cardFocus";

  let {
    question,
    program,
    onAnswer,
  }: {
    question: TmuxQuestion | null;
    /// The terminal's name, for the dialog's accessible name.
    program: string;
    onAnswer: (answer: TmuxAnswer) => void;
  } = $props();

  // Take the keyboard while the question stands, so Escape and the buttons
  // land here and not in the terminal, and give it back when it goes.
  let card = $state<HTMLDivElement | null>(null);
  const focus = createCardFocus();
  $effect(() => {
    if (question && card) focus.take(card);
    else if (!question) focus.release();
  });

  function onKeydown(e: KeyboardEvent): void {
    if (!question) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onAnswer("deny");
    }
  }
</script>

{#if question}
  <div class="tmux-consent" role="dialog" aria-label={`tmux control mode question for ${program}`}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="tc-card" tabindex="-1" bind:this={card} onkeydown={onKeydown}>
      <p class="tc-body">
        <strong>{question.program}</strong> asks to run tmux control mode in this terminal.
        {#if question.command}<code class="tc-command">{question.command}</code>{/if}
        Allow only if that is a tmux you started.
      </p>
      <div class="tc-actions">
        <button class="tc-action tc-allow" type="button" onclick={() => onAnswer("allow")}>Allow</button>
        <button class="tc-action" type="button" onclick={() => onAnswer("allow-for-tab")}>Allow for this tab</button>
        <button class="tc-action" type="button" onclick={() => onAnswer("deny")}>Deny</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tmux-consent {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    width: 30rem;
    max-width: calc(100% - 1.2rem);
    background: var(--bg-card);
    border: 1px solid var(--warn-text, var(--border));
    border-radius: 9px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 0.85rem;
    color: var(--text);
  }
  .tc-card {
    outline: none;
    padding: 0.6rem 0.8rem;
  }
  .tmux-consent:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tc-body {
    margin: 0 0 0.6rem;
    line-height: 1.4;
  }
  .tc-command {
    display: block;
    margin: 0.3rem 0;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .tc-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .tc-action {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    padding: 0.25rem 0.7rem;
    cursor: pointer;
  }
  .tc-allow {
    border-color: var(--accent);
  }
</style>
