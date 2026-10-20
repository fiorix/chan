<!-- The request column: the transfer panel at the top and the request cards
     (session handover, paste, upload) anchored at the bottom, at the
     window's right edge. Normal flow keeps simultaneous requests reachable
     beside the transfer panel, including in short windows, where the column
     scrolls. Its empty space passes pointer input through. -->
<script lang="ts">
  import TransferBubble from "./TransferBubble.svelte";
  import SessionHandoverBubble from "./SessionHandoverBubble.svelte";
  import PasteRequestBubble from "./PasteRequestBubble.svelte";
  import UploadRequestBubble from "./UploadRequestBubble.svelte";
</script>

<div class="request-corner">
  <TransferBubble />
  <div class="request-cards">
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
    right: 0.6rem;
    z-index: 41;
    width: 22rem;
    max-width: calc(100vw - 1.2rem);
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
