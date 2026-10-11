<script lang="ts">
  import { onMount } from "svelte";
  import EmptyPaneWelcome from "../../workspace-app/src/components/EmptyPaneWelcome.svelte";
  import {
    EMPTY_PANE_ANIMATIONS,
    stepEmptyPaneAnimation,
    type EmptyPaneAnimationId,
  } from "../../workspace-app/src/components/emptyPaneAnimations";
  import { pageWebglRenderer } from "../../workspace-app/src/components/webglRenderer";
  import credits from "./animation-credits.json";

  let selected = $state<EmptyPaneAnimationId>("radial-ribbons");
  let playing = $state(false);
  let theme = $state("dark");
  let webglAvailable = $state(true);
  const animation = $derived(EMPTY_PANE_ANIMATIONS.find(({ id }) => id === selected)!);
  const credit = $derived(credits.find(({ id }) => id === selected)!);
  const unavailable = $derived(animation.runner === "webgl2" && !webglAvailable);

  export function preview(id: string): void {
    const choice = EMPTY_PANE_ANIMATIONS.find((entry) => entry.id === id);
    if (!choice) return;
    selected = choice.id;
    playing = true;
  }

  onMount(() => {
    webglAvailable = pageWebglRenderer().kind !== "none";
    const requested = new URLSearchParams(window.location.search).get("a");
    if (requested) preview(requested);
  });

  // Share the selection, including changes made with the welcome's own keys.
  $effect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("a", selected);
    window.history.replaceState(null, "", url);
  });
</script>

<div class="gallery">
  <div class="gallery-toolbar">
    <label class="animation-choice">
      <span>Animation</span>
      <select value={selected} onchange={(event) => preview(event.currentTarget.value)}>
        {#each EMPTY_PANE_ANIMATIONS as entry (entry.id)}
          <option value={entry.id}>{entry.name}</option>
        {/each}
      </select>
    </label>
    <div class="gallery-buttons">
      <button type="button" onclick={() => preview(stepEmptyPaneAnimation(selected, -1))} aria-label="Previous animation">Previous</button>
      <button type="button" onclick={() => preview(stepEmptyPaneAnimation(selected, 1))} aria-label="Next animation">Next</button>
      <button type="button" class="play-button" onclick={() => (playing = !playing)} disabled={unavailable}>{playing && !unavailable ? "Stop preview" : "Play preview"}</button>
    </div>
    <label>
      <span>Preview theme</span>
      <select bind:value={theme}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  </div>

  <div class="gallery-stage" data-theme={theme}>
    {#if unavailable}
      <p class="stage-message" role="status">This animation needs WebGL 2, which is unavailable in this browser. Try Radial Ribbons, Dotted Waves, or another canvas animation.</p>
    {:else if playing}
      {#key theme}
        <EmptyPaneWelcome bind:animation={selected} startDelayMs={0} />
      {/key}
    {:else}
      <div class="stage-message">
        <span class="stage-mark" aria-hidden="true"></span>
        <p>{animation.name}</p>
        <button type="button" class="stage-play" onclick={() => (playing = true)}>Play animation</button>
      </div>
    {/if}
  </div>

  <div class="gallery-caption" aria-live="polite">
    <h2>{animation.name}</h2>
    <p>{animation.description}</p>
    <p>{credit.credit}</p>
    <div class="reference-links">
      {#each credit.references as reference (reference.url)}
        <a href={reference.url}>{reference.label}</a>
      {/each}
    </div>
  </div>
  <p class="gallery-help">Click the animation, then use left/right to browse, up/down for speed, or ? for a random choice. Your reduced-motion preference is respected.</p>
</div>

<style>
  .gallery {
    border: 1px solid var(--rule);
    border-radius: 12px;
    overflow: hidden;
    background: var(--panel);
  }
  .gallery-toolbar {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    gap: 16px;
    padding: 18px;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .animation-choice {
    flex: 1;
    min-width: 180px;
  }
  select, button {
    font: inherit;
    font-size: 0.9rem;
    color: var(--fg);
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 6px;
    min-height: 40px;
    padding: 8px 12px;
  }
  select {
    width: 100%;
  }
  button {
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .gallery-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .play-button {
    min-width: 116px;
  }
  .gallery-stage {
    display: flex;
    position: relative;
    height: clamp(300px, 53vw, 560px);
    overflow: hidden;
    background: #1c1c1e;
    --text: #ebebf0;
    --text-secondary: #8e8e93;
  }
  .gallery-stage[data-theme="light"] {
    background: #fff;
    --text: #1c1c1e;
    --text-secondary: #6c6c70;
  }
  .gallery-stage :global(.welcome:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -4px;
  }
  .stage-message {
    margin: auto;
    padding: 24px;
    max-width: 52ch;
    text-align: center;
    color: var(--text-secondary);
  }
  .stage-mark {
    display: block;
    width: 80px;
    height: 80px;
    margin: 0 auto 24px;
    background: currentColor;
    mask: url('/chan-mark.png') center / contain no-repeat;
  }
  .stage-play {
    color: #fff;
    background: #e8590c;
    border-color: #e8590c;
  }
  .gallery-caption {
    padding: 22px 24px 12px;
  }
  .gallery-caption h2 {
    margin: 0 0 8px;
    font-size: 1.3rem;
  }
  .gallery-caption p {
    margin: 6px 0;
    color: var(--muted);
  }
  .reference-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    margin-top: 12px;
  }
  .reference-links a {
    color: var(--accent);
  }
  .gallery-help {
    color: var(--muted);
    font-size: 0.85rem;
    padding: 0 24px 20px;
    margin: 0;
  }
  @media (max-width: 600px) {
    .animation-choice {
      flex-basis: 100%;
    }
    .gallery-toolbar {
      gap: 12px;
      padding: 14px;
    }
    .gallery-caption {
      padding-inline: 18px;
    }
    .gallery-help {
      padding-inline: 18px;
    }
  }
</style>
