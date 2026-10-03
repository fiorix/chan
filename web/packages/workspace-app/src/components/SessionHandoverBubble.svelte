<!-- Handover-request notification for `cs session handover`.

     The leader's window gets a `handover_prompt` window command when a follower
     asks to take leadership; this corner card (a RequestCard)
     shows who is asking, with Accept / Reject. Like the survey overlay, EVERY
     exit (Accept, Reject, Escape, close) is a real reply that POSTs to
     /api/session/handover/reply and unblocks the requester's blocked CLI, so a
     stray close can never hang it. Not persisted: a reload resolves the request
     server-side as a timeout. Mounted once at the App root. -->
<script lang="ts">
  import { sessionState, acceptHandover, rejectHandover } from "../state/session.svelte";
  import RequestCard from "./RequestCard.svelte";

  const active = $derived(sessionState.handover);
</script>

<RequestCard
  label="Handover request"
  title="Handover request"
  closeLabel="Reject handover"
  confirmLabel="Accept"
  cancelLabel="Reject"
  busy={active?.busy ?? false}
  requestId={active?.requestId ?? null}
  onConfirm={() => void acceptHandover()}
  onCancel={() => void rejectHandover()}
>
  <strong>{active?.fromName ?? active?.fromWindowId}</strong> wants to become the session leader.
</RequestCard>
