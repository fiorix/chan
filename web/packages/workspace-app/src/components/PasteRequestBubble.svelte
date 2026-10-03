<!-- Paste-request notification for `cs paste`.

     When a `clipboard_read` window command's immediate read is still pending
     past the threshold (a browser paste-permission prompt nobody clicked),
     this corner card (a RequestCard) says what the CLI is
     waiting for. [Paste] runs ONE clipboard access inside the click's user
     activation; [Cancel] (also Escape / close) answers the blocked CLI
     immediately with an error instead of leaving it to the 30s timeout. The
     card dismisses when its request's reply lands (whichever path answered
     first; the window bus is once-only, later replies 404 harmlessly). Not
     persisted: a reload leaves the CLI to the server-side timeout. Mounted
     once at the App root. -->
<script lang="ts">
  import {
    pasteRequestState,
    confirmPasteCard,
    cancelPasteCard,
  } from "../state/pasteRequest.svelte";
  import RequestCard from "./RequestCard.svelte";

  const active = $derived(pasteRequestState.card);
</script>

<RequestCard
  label="Paste request"
  title="cs paste"
  closeLabel="Cancel paste"
  confirmLabel="Paste"
  cancelLabel="Cancel"
  busy={active?.busy ?? false}
  requestId={active?.requestId ?? null}
  onConfirm={() => void confirmPasteCard()}
  onCancel={() => void cancelPasteCard()}
>
  <strong>cs paste</strong> is waiting for this window's clipboard.
</RequestCard>
