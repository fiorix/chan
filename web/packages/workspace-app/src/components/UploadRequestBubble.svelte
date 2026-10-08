<script lang="ts">
  import RequestCard from "./RequestCard.svelte";
  import { transfers } from "../state/transfers.svelte";
  import { uploadRequestState, uploadDestination, chooseUploadRequest, cancelUploadRequest, uploadRequestFocus } from "../state/uploadRequest.svelte";

  const active = $derived(uploadRequestState.pending);
</script>

{#if active && !transfers.shown}
  <div class="upload-request-bubble" use:uploadRequestFocus={active.id}>
    <RequestCard
      label="Upload request"
      title="cs upload"
      closeLabel="Cancel upload request"
      confirmLabel="Choose files"
      cancelLabel="Cancel"
      busy={false}
      requestId={active.id}
      manageFocus={false}
      onConfirm={() => chooseUploadRequest(active.id)}
      onCancel={() => cancelUploadRequest(active.id)}
    >
      Choose files to upload to <strong>{uploadDestination(active)}</strong>.
      {#if active.replaced} Replaces the waiting request for {active.replaced}.{/if}
      {#if active.error} <span role="alert">{active.error}</span>{/if}
    </RequestCard>
  </div>
{/if}
