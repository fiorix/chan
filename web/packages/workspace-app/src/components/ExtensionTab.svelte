<script lang="ts">
  import { Check, Command as CommandIcon, Maximize2, Minimize2, RefreshCw, Settings2, X } from "@lucide/svelte";
  import { onDestroy, onMount } from "svelte";
  import { sessionWindowId } from "../api/client";
  import { apiPath } from "../api/transport";
  import {
    allCommands,
    commandContext,
    commandState,
    commandTitle,
    type CommandContext,
  } from "../state/commands";
  // The menu names its rows through the catalog, which this fills.
  import "../state/commands/install";
  import {
    EXTENSION_KEYMAP_MESSAGE,
    EXTENSION_SESSION_CONTEXT_MESSAGE,
    EXTENSION_VIEW_STATE_MESSAGE,
    extensionPresentationAction,
    extensionHostKeys,
    hostKeyId,
    isAdvertisedHostKey,
    isExtensionKeydownMessage,
    keyboardEventFromExtension,
  } from "../state/extensionBridge";
  import {
    EXTENSION_COMMAND_MESSAGE,
    EXTENSION_READY_MESSAGE,
    extensionHasCapability,
    extensionFor,
    extensionPresenting,
    extensionsReady,
    isExtensionCommandResult,
    markExtensionFrameReady,
    registerExtensionFrame,
    reloadExtensionTab,
    resetExtensionFrame,
    setExtensionPresenting,
    toggleExtensionPresentation,
  } from "../state/extensions.svelte";
  import { extensionPresentationLayer } from "../state/extensionPresentation";
  import { notify } from "../state/notify.svelte";
  import { sessionState } from "../state/session.svelte";
  import { chordFor, shortcutLabel } from "../state/shortcuts";
  import { openCommandLauncherFromMenu } from "../state/store.svelte";
  import {
    closeTab,
    flipHybrid,
    panesHaveSides,
    type ExtensionTab,
  } from "../state/tabs.svelte";
  import { closeTabMenu, tabMenu } from "../state/tabMenu.svelte";
  import HamburgerMenu from "./HamburgerMenu.svelte";

  type Props = { tab: ExtensionTab; paneId: string; active?: boolean };
  let { tab, paneId, active = true }: Props = $props();

  const extension = $derived(extensionFor(tab.extensionId));
  // Tracks the live catalog: refreshExtensions() after a watch reconnect
  // flows a re-minted capability path straight into the iframe src (Svelte
  // rewrites the attribute only when the string changes, so an unchanged
  // path never re-navigates), and a vanished extension drops the frame to
  // the unavailable branch below.
  const frameSrc = $derived(
    extension && extension.running !== false ? apiPath(extension.entry_path) : undefined,
  );
  const catalogReady = $derived(extensionsReady());
  let frame: HTMLIFrameElement | undefined = $state();
  let menu: HamburgerMenu | undefined = $state();
  let menuOpen = $state(false);
  // Whether the tab is shown in presentation is state the launcher's toggle
  // reads and flips too, so it lives with the frame registry.
  const presenting = $derived(extensionPresenting(tab.id));
  const presents = $derived(extensionHasCapability(extension, "presentation"));
  let unregisterFrame: (() => void) | undefined;
  // Fail-closed until the first postHostKeys: only a relayed chord whose
  // identity matches an advertised host key is dispatched locally.
  let advertisedKeys = new Set<string>();

  // The command context as it reads with this tab focused: a row's check is
  // the catalog's state for the tab the menu belongs to.
  const menuContext = $derived<CommandContext>({
    ...commandContext(),
    activeSurface: "extension",
    activeTabId: tab.id,
    activeExtensionId: tab.extensionId,
  });

  // The launcher's own toggle has no catalog row; the shortcut table names it.
  const launcherLabel = shortcutLabel("app.launcher.toggle");

  function chordLabel(id: string): string {
    return chordFor(id) ?? "";
  }

  // First-placement estimate for the menu, which measures itself once open.
  const menuHeight = $derived(
    42 + 36 * (2 + (presents ? 1 : 0) + (panesHaveSides() ? 1 : 0) + (presenting ? 0 : 1)),
  );

  // The catalog is resolved again before the frame loads, so an extension
  // that exited shows its status instead of a dead frame.
  function reloadFrame(): void {
    if (frame && frameSrc) frame.src = frameSrc;
  }

  function reload(): void {
    menu?.close();
    void reloadExtensionTab(tab.id);
  }

  function doFlip(): void {
    menu?.close();
    flipHybrid(paneId);
  }

  function togglePresentation(): void {
    menu?.close();
    toggleExtensionPresentation(tab.id, tab.extensionId);
  }

  function closeOwnTab(): void {
    menu?.close();
    setExtensionPresenting(tab.id, false);
    void closeTab(paneId, tab.id);
  }

  function openCommands(event: MouseEvent): void {
    const row = event.currentTarget as Element;
    menu?.close();
    openCommandLauncherFromMenu(row);
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    menu?.openAtCursor(event.clientX, event.clientY);
  }

  function postHostKeys(): void {
    const keys = extensionHostKeys(allCommands());
    advertisedKeys = new Set(keys.map(hostKeyId));
    frame?.contentWindow?.postMessage(
      {
        type: EXTENSION_KEYMAP_MESSAGE,
        keys,
      },
      "*",
    );
  }

  function postSessionContext(): void {
    if (!extensionHasCapability(extension, "session-context")) return;
    frame?.contentWindow?.postMessage(
      {
        type: EXTENSION_SESSION_CONTEXT_MESSAGE,
        self_id: sessionWindowId(),
        participants: sessionState.participants.map((participant) => ({
          id: participant.window_id,
          name: participant.name,
          role: participant.role,
          status: participant.status,
        })),
      },
      "*",
    );
  }

  function postViewState(): void {
    frame?.contentWindow?.postMessage(
      {
        type: EXTENSION_VIEW_STATE_MESSAGE,
        active: (active || presenting) && document.visibilityState === "visible",
      },
      "*",
    );
  }

  function postCommand(command: { id: string; requestId: string }): void {
    frame?.contentWindow?.postMessage(
      {
        type: EXTENSION_COMMAND_MESSAGE,
        id: command.id,
        request_id: command.requestId,
      },
      "*",
    );
  }

  function onFrameLoad(): void {
    resetExtensionFrame(tab.id);
    postHostKeys();
    postSessionContext();
    postViewState();
  }

  function onFrameMessage(event: MessageEvent): void {
    if (event.source !== frame?.contentWindow) return;
    if (event.data?.type === EXTENSION_READY_MESSAGE) {
      markExtensionFrameReady(tab.id);
      postHostKeys();
      postSessionContext();
      postViewState();
      return;
    }
    if (isExtensionKeydownMessage(event.data)) {
      if (!isAdvertisedHostKey(advertisedKeys, event.data)) return;
      document.dispatchEvent(keyboardEventFromExtension(event.data));
      return;
    }
    if (isExtensionCommandResult(event.data)) {
      if (event.data.message) notify(event.data.message);
      else if (!event.data.ok) notify(`${tab.title} refused the command`);
      return;
    }
    const presentation = extensionPresentationAction(event.data);
    if (!presentation || !presents) return;
    if (presentation === "toggle") toggleExtensionPresentation(tab.id, tab.extensionId);
    else setExtensionPresenting(tab.id, presentation === "enter");
  }

  onMount(() => {
    unregisterFrame = registerExtensionFrame(tab.id, postCommand, reloadFrame);
    window.addEventListener("message", onFrameMessage);
    document.addEventListener("visibilitychange", postViewState);
  });
  onDestroy(() => {
    unregisterFrame?.();
    window.removeEventListener("message", onFrameMessage);
    document.removeEventListener("visibilitychange", postViewState);
  });

  // Refresh the child-side claimed-key set when preferences replace a chord.
  // `onload` below repeats the send after a navigation, since a message posted
  // while the iframe document is still loading has no durable recipient.
  $effect(() => {
    postHostKeys();
  });

  $effect(() => {
    postSessionContext();
  });

  $effect(() => {
    postViewState();
  });

  // Pane.svelte forwards a tab-title right click through the shared tab-menu
  // bus. Consume it here so title and body expose the same actions.
  $effect(() => {
    if (tabMenu.openForTabId !== tab.id || !tabMenu.anchor || !menu) return;
    const { left, top } = tabMenu.anchor;
    closeTabMenu();
    menu.openAtCursor(left, top);
  });
</script>

<div
  class="extension-tab"
  class:active={active || presenting}
  class:presenting
  aria-label={`${tab.title} extension`}
  aria-hidden={!active && !presenting}
  oncontextmenu={onContextMenu}
  role="region"
  use:extensionPresentationLayer={presenting}
>
  <HamburgerMenu
    bind:this={menu}
    bind:open={menuOpen}
    showTrigger={false}
    width={210}
    height={menuHeight}
  >
    <!-- The extension's own rows, then the tail every tab menu ends with
         (Flip pane where the window's panes have sides, Close tab) and the
         launcher row. A presented frame covers the launcher, so its row is
         left out while the tab presents. -->
    <li>
      <button role="menuitem" onclick={reload} disabled={!extension}>
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{commandTitle("app.extension.reload")}</span>
      </button>
    </li>
    {#if presents}
      {@const on = commandState("app.extension.present", menuContext) === true}
      <li>
        <button role="menuitemcheckbox" aria-checked={on} onclick={togglePresentation}>
          {#if on}
            <Check size={16} strokeWidth={2} aria-hidden="true" />
          {:else}
            <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
          {/if}
          <span class="menu-row-label">{commandTitle("app.extension.present")}</span>
        </button>
      </li>
    {/if}
    <li class="sep" role="separator"></li>
    {#if panesHaveSides()}
      <li>
        <button role="menuitem" onclick={doFlip}>
          <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span class="menu-row-label">{commandTitle("app.pane.flip")}</span>
          <span class="menu-row-chord">{chordLabel("app.pane.flip")}</span>
        </button>
      </li>
    {/if}
    <li>
      <button role="menuitem" onclick={closeOwnTab}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="menu-row-label">{commandTitle("app.tab.close")}</span>
        <span class="menu-row-chord">{chordLabel("app.tab.close")}</span>
      </button>
    </li>
    {#if !presenting}
      <li class="sep" role="separator"></li>
      <li>
        <button role="menuitem" onclick={openCommands}>
          <CommandIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span class="menu-row-label">{launcherLabel}</span>
          <span class="menu-row-chord">{chordLabel("app.launcher.toggle")}</span>
        </button>
      </li>
    {/if}
  </HamburgerMenu>

  {#if presenting}
    <div class="presentation-chrome" aria-label="Extension presentation controls">
      <strong>{tab.title}</strong>
      <div>
        <!-- Restore is this bar's way out of presentation and keeps its own
             word: the toggle's name would read as entering it. -->
        <button type="button" onclick={togglePresentation} aria-label="Restore extension">
          <Minimize2 size={17} aria-hidden="true" />
          <span>Restore</span>
        </button>
        <button type="button" onclick={closeOwnTab} aria-label={commandTitle("app.tab.close")}>
          <X size={17} aria-hidden="true" />
          <span>{commandTitle("app.tab.close")}</span>
        </button>
      </div>
    </div>
  {/if}

  {#if frameSrc}
    <!-- The capability path shares Chan's network origin so one forwarded port
         is sufficient. Omitting allow-same-origin keeps extension scripts in
         an opaque sandbox that cannot reach the parent DOM or Chan APIs. -->
    <iframe
      bind:this={frame}
      src={frameSrc}
      title={tab.title}
      sandbox="allow-forms allow-scripts"
      referrerpolicy="no-referrer"
      onload={onFrameLoad}
    ></iframe>
  {:else}
    <div class="extension-status" role="status">
      {#if catalogReady}
        <strong>{tab.title} is unavailable.</strong>
        {#if extension?.running === false}
          <span>Its process exited. Check its output, then restart Chan.</span>
        {:else}
          <span>Check its config or process output, then restart Chan.</span>
        {/if}
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

  .extension-tab.presenting {
    position: fixed;
    inset: 0;
    z-index: 26000;
    display: grid;
    grid-template-rows: 42px minmax(0, 1fr);
    visibility: visible;
    pointer-events: auto;
    background: var(--bg, #0b0f14);
  }

  :global(.extension-tab[popover]) {
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    color: inherit;
  }

  .presentation-chrome {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-width: 0;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev, #151b23);
    color: var(--text, #eef2f7);
  }

  .presentation-chrome > div {
    display: flex;
    gap: 6px;
  }

  .presentation-chrome button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface, #202936);
    color: inherit;
    cursor: pointer;
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
