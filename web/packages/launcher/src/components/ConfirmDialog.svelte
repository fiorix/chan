<script lang="ts">
  // The generic confirm dialog. Renders the in-SPA Modal (never a native
  // window.confirm -- WKWebView blocks those) with the request's message and a
  // Confirm / Cancel pair. Confirm runs the stored action then closes; Cancel
  // and the Modal's close (backdrop / × / Escape) dismiss without running it.
  // Mounted in App.svelte only while a request is open.
  import Modal from "./Modal.svelte";
  import { confirm, resolveConfirm, cancelConfirm } from "../state/confirm.svelte";
</script>

<Modal title={confirm.title} onclose={cancelConfirm} returnFocus={confirm.opener}>
  <p class="message">{confirm.message}</p>
  <div class="dialog-footer">
    <button class="btn" type="button" disabled={confirm.busy} onclick={cancelConfirm}>Cancel</button>
    <button class="btn primary" type="button" disabled={confirm.busy} onclick={resolveConfirm}>
      {confirm.confirmLabel}
    </button>
  </div>
</Modal>

<style>
  .message {
    margin: 0;
    color: var(--text);
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1.5rem;
  }
</style>
