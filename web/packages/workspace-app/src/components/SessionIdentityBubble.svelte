<script lang="ts">
  import RequestCard from "./RequestCard.svelte";
  import { clientSession, answerClientIdentification } from "../state/clientSession.svelte";
</script>

<RequestCard
  label="Session identity"
  title="Identify this client"
  closeLabel="Cancel identification"
  confirmLabel="Identify this client"
  cancelLabel="Cancel"
  busy={clientSession.busy}
  requestId={clientSession.requestId}
  onConfirm={() => void answerClientIdentification(true)}
  onCancel={() => void answerClientIdentification(false)}
>
  Select this on the laptop or browser you are using. Other clients viewing the same terminal have their own identity.
</RequestCard>
