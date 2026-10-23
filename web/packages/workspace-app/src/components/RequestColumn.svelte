<!-- The request column: the transfer panel at the top and the request cards
     (client identification, session handover, paste, upload) anchored at the
     bottom, at the workspace's right edge. Normal flow keeps them reachable
     beside the transfer panel, including in short windows, where the column
     scrolls. Its empty space passes pointer input through. -->
<script lang="ts">
  import { browserSidePanes, paneWidths } from "../state/store.svelte";
  import { windowCaps } from "../state/windowCaps";
  import TransferBubble from "./TransferBubble.svelte";
  import SessionIdentityBubble from "./SessionIdentityBubble.svelte";
  import SessionHandoverBubble from "./SessionHandoverBubble.svelte";
  import PasteRequestBubble from "./PasteRequestBubble.svelte";
  import UploadRequestBubble from "./UploadRequestBubble.svelte";

  // Beside a right-docked Files browser, as the status bar is, so a card
  // never covers the dock. The condition is the dock's own in App.svelte,
  // and its width is live while the resize handle moves.
  const rightDock = $derived(windowCaps.files && browserSidePanes.right ? paneWidths.browser : 0);
</script>

<div class="request-corner" style:--right-dock={`${rightDock}px`}>
  <TransferBubble />
  <div class="request-cards">
    <SessionIdentityBubble />
    <SessionHandoverBubble />
    <PasteRequestBubble />
    <UploadRequestBubble />
  </div>
</div>

<style>
  .request-corner {
    position: fixed;
    top: 5.5rem;
    bottom: 2rem;
    right: calc(var(--right-dock, 0px) + 0.6rem);
    z-index: 41;
    width: 22rem;
    max-width: calc(100vw - var(--right-dock, 0px) - 1.2rem);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 2px;
    overflow-y: auto;
    pointer-events: none;
  }
  .request-cards {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    flex-shrink: 0;
  }
  .request-corner :global(.request-card),
  .request-corner :global(.transfer-bubble) {
    position: relative;
    inset: auto;
    width: 100%;
    max-width: 100%;
    flex-shrink: 0;
    pointer-events: auto;
    box-sizing: border-box;
  }
</style>
