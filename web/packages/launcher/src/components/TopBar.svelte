<script lang="ts">
  // The launcher's top bar: the screen title block (on the desktop surface a
  // toggle that flips the main area between Computers and Gateways), a
  // Gmail-style Select-mode toggle. The add-workspace and
  // add-devserver entry points live in the library tree (the LOCAL header's
  // [new workspace] and the bottom "Add devserver" dashed button), and
  // open-terminal lives in each machine header, so the top bar stays the
  // global chrome: title + Computers command launcher + select.
  import { Command, SquareCheckBig } from "lucide-svelte";
  import { selection, toggleSelectMode } from "../state/selection.svelte";
  import { readOnly, hasDesktopBridge } from "../state/capabilities";
  import { screen, toggleScreen } from "../state/screen.svelte";
  import {
    activeCommandLauncherDraft,
    toggleCommandLauncher,
  } from "../state/commandLauncher.svelte";

  function showCommandLauncher(): void {
    toggleCommandLauncher();
  }

  const title = $derived(screen.current === "computers" ? "Computers" : "Gateways");
  const subtitle = $derived(
    screen.current === "computers"
      ? "This machine & devservers"
      : "Connection to remote gateways",
  );
  const flipLabel = $derived(screen.current === "computers" ? "Show gateways" : "Show computers");
</script>

<header class="topbar">
  <div class="title">
    {#if hasDesktopBridge}
      <h1 class="brand">
        <button
          class="title-toggle"
          type="button"
          aria-label={flipLabel}
          title={flipLabel}
          onclick={toggleScreen}>
          {title}
        </button>
      </h1>
      <p class="subtitle">{subtitle}</p>
    {:else}
      <h1 class="brand">Computers</h1>
      <p class="subtitle">This machine &amp; devservers</p>
    {/if}
  </div>
  <div class="actions">
    {#if !readOnly && screen.current === "computers"}
      <button
        class="icon-btn command"
        class:active={activeCommandLauncherDraft().visible}
        type="button"
        aria-label="Open command launcher"
        title="Command launcher"
        onclick={showCommandLauncher}>
        <Command size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    {/if}
    {#if !readOnly}
      <button
        class="icon-btn select"
        class:on={selection.selectMode}
        type="button"
        aria-label={selection.selectMode ? "Exit select mode" : "Select"}
        title={selection.selectMode ? "Exit select" : "Select"}
        onclick={toggleSelectMode}>
        <SquareCheckBig size={16} />
      </button>
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }

  .title {
    min-width: 0;
  }

  .brand {
    display: block;
    font-size: 1.15rem;
    font-weight: 700;
    gap: 0;
    letter-spacing: -0.01em;
    line-height: 1.1;
    margin: 0;
    text-decoration: none;
  }

  /* The title as a flip toggle: a bare button inheriting the h1's face, with
     the brand hover as its affordance. */
  .title-toggle {
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
    transition: color 160ms ease;
  }

  .title-toggle:hover {
    color: var(--brand);
  }

  .subtitle {
    margin: 0.15rem 0 0;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .icon-btn.command.active {
    border-color: var(--brand);
    color: var(--brand);
    background: color-mix(in srgb, var(--brand) 12%, transparent);
  }

  /* The sheet's hover rule outranks its `.on` tint, so this rule holds the
     accent border and colour under the pointer, as the Command toggle's own
     rule holds its tint. */
  .icon-btn.select.on {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
