<script lang="ts">
  import { RefreshCw, Settings2 } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { apiPath } from "../api/transport";
  import { allCommands } from "../state/commands";
  import {
    EXTENSION_KEYMAP_MESSAGE,
    extensionHostKeys,
    isExtensionKeydownMessage,
    keyboardEventFromExtension,
  } from "../state/extensionBridge";
  import {
    extensionFor,
    extensionsReady,
  } from "../state/extensions.svelte";
  import {
    flipHybrid,
    layout,
    type ExtensionTab,
  } from "../state/tabs.svelte";
  import { closeTabMenu, tabMenu } from "../state/tabMenu.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";

  type Props = { tab: ExtensionTab; active?: boolean };
  let { tab, active = true }: Props = $props();

  const extension = $derived(extensionFor(tab.extensionId));
  const frameSrc = $derived(extension ? apiPath(extension.entry_path) : undefined);
  const catalogReady = $derived(extensionsReady());
  let frame: HTMLIFrameElement | undefined = $state();
  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);

  function reload(): void {
    menu?.close();
    if (frame && frameSrc) frame.src = frameSrc;
  }

  function doFlip(): void {
    menu?.close();
    flipHybrid(layout.activePaneId);
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    menu?.openAtCursor(event.clientX, event.clientY);
  }

  function postHostKeys(): void {
    frame?.contentWindow?.postMessage(
      {
        type: EXTENSION_KEYMAP_MESSAGE,
        keys: extensionHostKeys(allCommands()),
      },
      "*",
    );
  }

  function onFrameMessage(event: MessageEvent): void {
    if (event.source !== frame?.contentWindow) return;
    if (!isExtensionKeydownMessage(event.data)) return;
    document.dispatchEvent(keyboardEventFromExtension(event.data));
  }

  onMount(() => window.addEventListener("message", onFrameMessage));
  onDestroy(() => window.removeEventListener("message", onFrameMessage));

  // Refresh the child-side claimed-key set when preferences replace a chord.
  // `onload` below repeats the send after a navigation, since a message posted
  // while the iframe document is still loading has no durable recipient.
  $effect(() => {
    postHostKeys();
  });

  // Pane.svelte forwards a tab-title right click through the shared tab-menu
  // bus. Consume it here so title and body expose the same two actions.
  $effect(() => {
    if (tabMenu.openForTabId !== tab.id || !tabMenu.anchor || !menu) return;
    const { left, top } = tabMenu.anchor;
    closeTabMenu();
    menu.openAtCursor(left, top);
  });
</script>

<div
  class="extension-tab"
  class:active
  aria-label={`${tab.title} extension`}
  aria-hidden={!active}
  oncontextmenu={onContextMenu}
  role="region"
>
  <HamburgerMenu
    bind:this={menu}
    bind:open={menuOpen}
    showTrigger={false}
    width={210}
    height={96}
  >
    <li>
      <button role="menuitem" onclick={doFlip}>
        <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Flip</span>
      </button>
    </li>
    <li>
      <button role="menuitem" onclick={reload} disabled={!extension}>
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Reload extension</span>
      </button>
    </li>
  </HamburgerMenu>

  {#if extension}
    <!-- The capability path shares Chan's network origin so one forwarded port
         is sufficient. Omitting allow-same-origin keeps extension scripts in
         an opaque sandbox that cannot reach the parent DOM or Chan APIs. -->
    <iframe
      bind:this={frame}
      src={frameSrc}
      title={tab.title}
      sandbox="allow-forms allow-scripts"
      referrerpolicy="no-referrer"
      onload={postHostKeys}
    ></iframe>
  {:else}
    <div class="extension-status" role="status">
      {#if catalogReady}
        <strong>{tab.title} is unavailable.</strong>
        <span>Check its config or process output, then restart Chan.</span>
      {:else}
        <span>Loading extension...</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .extension-tab {
    position: absolute;
    inset: 0;
    min-width: 0;
    min-height: 0;
    visibility: hidden;
    pointer-events: none;
    background: var(--surface, var(--bg));
  }

  .extension-tab.active {
    visibility: visible;
    pointer-events: auto;
  }

  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #11151b;
  }

  .extension-status {
    width: 100%;
    height: 100%;
    display: grid;
    place-content: center;
    gap: 0.5rem;
    padding: 2rem;
    text-align: center;
    color: var(--muted);
  }

  .extension-status strong {
    color: var(--text);
  }
</style>
