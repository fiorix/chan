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
  import { consumeKey } from "../state/shortcuts";
  import { activeTabInPane, layout, tabFocusPulse } from "../state/tabs.svelte";
  import { canTakeFocus } from "@chan/web-shared/modal-focus";
  import { handKeyboardToOwner, mayFocus, ownerTag, registerKeyboardTaker } from "../state/keyboardOwner.svelte";

  let {
    tabId = null,
    shown = true,
    restoreFocus,
  }: {
    tabId?: SurveySlot;
    shown?: boolean;
    restoreFocus?: () => void;
  } = $props();

  const slot = $derived(tabId);
  const active = $derived(surveyFor(slot));
  const busy = $derived(surveyBusy(slot));

  function ownsKeyboard(): boolean {
    if (slot === null) return true;
    const pane = layout.nodes[layout.activePaneId];
    return pane?.kind === "leaf" && activeTabInPane(pane)?.id === slot;
  }

  // Sequential navigation never moves the active pane, so a survey that does
  // not own the keyboard keeps its buttons out of the Tab order: a Tab walk
  // from the focused pane passes its card by. A press still answers it, since
  // the pane makes itself the focused one on the press first.
  const buttonTabIndex = $derived(ownsKeyboard() ? 0 : -1);

  // The body's markup can hold focusables of its own, which leave the Tab
  // order with the buttons and get their own tabindex back when the survey
  // owns the keyboard: a link in any namespace (a bare URL the markdown links,
  // an SVG link by either spelling, an image map's area), a control, a
  // details, whose summary the browser supplies when the markup has none,
  // media with controls, an element with a tabindex of its own, and a scroll
  // container, which Chrome and Firefox put in the Tab order. The sanitizer
  // strips `contenteditable`. A negative tabindex still lets a press focus
  // and follow them.
  const BODY_FOCUSABLE =
    "[*|href], button, input, select, textarea, iframe, details, summary, " +
    "audio[controls], video[controls], [tabindex]";
  function scrolls(el: Element): boolean {
    const { overflowX, overflowY } = getComputedStyle(el);
    return [overflowX, overflowY].some((overflow) => overflow === "auto" || overflow === "scroll");
  }
  let body = $state<HTMLDivElement | null>(null);
  $effect(() => {
    // A new body replaces the markup, so the hold moves to the new elements.
    active?.bodyMarkdown;
    if (!body || ownsKeyboard()) return;
    const held = [...body.querySelectorAll("*")]
      .filter((el) => el.matches(BODY_FOCUSABLE) || scrolls(el))
      .map((el) => [el, el.getAttribute("tabindex")] as const);
    for (const [el] of held) el.setAttribute("tabindex", "-1");
    return () => {
      for (const [el, own] of held) {
        if (own === null) el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", own);
      }
    };
  });

  // A visible survey owns the keyboard only in its focused pane. Retain its
  // first return target across tab and pane switches. Read live ownership in
  // the effect and its queued callbacks, since docking can move the terminal
  // without remounting this overlay, and focus can move before a callback.
  let card = $state<HTMLDivElement | null>(null);
  let overlay = $state<HTMLDivElement | null>(null);
  let returnFocus: HTMLElement | null = null;
  let focusedSurveyId: string | null = null;

  // Handed the keyboard as its owner, the survey's card takes it while its
  // survey shows where it owns the keyboard.
  $effect(() => {
    if (!overlay) return;
    return registerKeyboardTaker(overlay, () => {
      if (shown && active && ownsKeyboard()) card?.focus({ preventScroll: true });
    });
  });
  $effect(() => {
    const id = active?.surveyId ?? null;
    const eligible = ownsKeyboard();
    // Window-wide surveys are unrelated to terminal-tab rotation. Avoid
    // making their focus behavior depend on terminal pulses.
    if (slot !== null) tabFocusPulse.value;
    if (!id) {
      if (!focusedSurveyId) return;
      focusedSurveyId = null;
      const target = returnFocus;
      returnFocus = null;
      queueMicrotask(() => {
        // The remembered element gets the keyboard back only where the
        // keyboard's owner lets it: a survey closing under a dialog, the
        // launcher or an overlay must not move focus into the composer
        // behind them, and a remembered survey card takes it only while its
        // survey owns the keyboard.
        const mayRestore = mayFocus(target?.isConnected ? target : null);
        if (!active && shown && ownsKeyboard() && mayRestore) {
          if (target?.isConnected) target.focus({ preventScroll: true });
          else restoreFocus?.();
        } else if (!active && slot === null && !canTakeFocus(document.activeElement)) {
          // A window-wide survey held the keyboard over the owner under it
          // (a dialog): its close hands the keyboard back to that owner.
          handKeyboardToOwner();
        }
      });
      return;
    }
    // A hidden survey must not hold the visible tab's keyboard; an unfocused
    // one must not hold another pane's, whether its card took the keyboard or
    // focus reached the card some other way. Keep the survey and its return
    // target intact for the later tab or pane return.
    if (!shown || !eligible) {
      if (!eligible && card?.contains(document.activeElement)) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
      return;
    }
    if (!focusedSurveyId) {
      const current = document.activeElement;
      if (current instanceof HTMLElement && current !== document.body) {
        // A per-terminal survey first shown from a hidden tab can observe the
        // previous tab or the clicked tab header. Only remember a target from
        // inside the owning terminal; TerminalTab restores xterm itself when
        // no eligible target exists.
        const owner = card?.closest(".terminal-tab");
        returnFocus = slot === null || owner?.contains(current) ? current : null;
      }
    }
    // A card over a terminal asks the keyboard's owner: it takes the keyboard
    // only while nothing above it holds it (a dialog, a window-wide survey,
    // an overlay, the Computers launcher). Asking reads the owners' state, so
    // this effect runs again when the owner above lets go, and the card takes
    // the keyboard then.
    if (slot !== null) {
      if (!mayFocus(card)) return;
      focusedSurveyId = id;
      (document.activeElement as HTMLElement | null)?.blur();
      queueMicrotask(() => {
        if (shown && active?.surveyId === id && ownsKeyboard() && mayFocus(card)) {
          card?.focus({ preventScroll: true });
        }
      });
      return;
    }
    // The window-wide card takes the keyboard on its arrival where the
    // keyboard's owner lets it: it paints over the dialogs of its tier and
    // takes it from them, and leaves it to the Computers launcher and the
    // covers over the window. Asking reads the owners' state, so this effect
    // runs again when one lets go. Once it took the keyboard, a re-run (a
    // pane event) leaves the keyboard where its owner holds it.
    if (focusedSurveyId === id || !mayFocus(card)) return;
    focusedSurveyId = id;
    (document.activeElement as HTMLElement | null)?.blur();
    queueMicrotask(() => {
      if (shown && active?.surveyId === id && ownsKeyboard() && mayFocus(card)) {
        card?.focus({ preventScroll: true });
      }
    });
  });

  // Number keys 1..N pick an option; F follows up; X or Escape dismisses. F
  // and X/Escape are standard on every survey. Scoped to the focused
  // card (NOT the window) so each terminal's survey handles its own keys, a
  // focused terminal does not swallow the keystroke into its PTY, and a handled
  // Escape does not bubble out to close other overlays. The card answers them
  // unmodified, as the viewers do: a chord with Ctrl, Cmd or Alt held is the
  // app's and travels on. A card whose survey does not own the keyboard
  // answers no key: focus can still reach it (a script, assistive
  // technology), and its keys travel on as from any element outside the
  // focused pane.
  function onCardKeydown(e: KeyboardEvent): void {
    const s = active;
    if (!s) return;
    if (!ownsKeyboard()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key >= "1" && e.key <= "9") {
      const idx = Number(e.key) - 1;
      if (idx < s.options.length) {
        consumeKey(e);
        void pickOption(slot, idx);
      }
      return;
    }
    if (e.key === "f" || e.key === "F") {
      consumeKey(e);
      void requestFollowup(slot);
      return;
    }
    if (e.key === "x" || e.key === "X" || e.key === "Escape") {
      consumeKey(e);
      void dismissSurvey(slot);
    }
  }
</script>

{#if active && shown}
  <div
    bind:this={overlay}
    class="survey-overlay"
    class:per-terminal={slot !== null}
    role="dialog"
    aria-modal="true"
    data-keyboard-owner={slot === null ? ownerTag("modal") : ownerTag("terminal-survey", slot)}
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
      <div class="survey-body" bind:this={body}>{@html renderMarkdownWithBreaks(active.bodyMarkdown)}</div>
      <ul class="survey-options">
        {#each active.options as option, i (i)}
          <li>
            <button
              type="button"
              class="survey-option"
              tabindex={buttonTabIndex}
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
          tabindex={buttonTabIndex}
          disabled={busy}
          onclick={() => requestFollowup(slot)}
        >
          [F] Follow up later
        </button>
        <button
          type="button"
          class="survey-dismiss"
          tabindex={buttonTabIndex}
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
  /* Window-wide: over the panes, the menus (29000), the command deck
     (29800 at most) and the dialogs (ModalShell's 26000 and up), whose
     keyboard it holds by painting over them, and under the covers over the
     window (the reconnect cover's 30000 and up), which paint over it and
     hold the keyboard while they show. */
  .survey-overlay {
    position: fixed;
    inset: 0;
    z-index: 29900;
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
