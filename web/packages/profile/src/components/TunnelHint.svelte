<script lang="ts">
  import { onMount } from "svelte";
  import { tunnelCommand } from "../lib/tunnelCommand";
  import { gatewayStore } from "../state/gateway.svelte";

  onMount(() => { void gatewayStore.load(); });
</script>

<code class="tunnel-command">{tunnelCommand(gatewayStore.tunnelUrl)}</code>
<span class="explanation">
  <code>chan devserver start</code> installs a service that keeps the token and URL;
  use <code>chan devserver run</code> with the same flag for the foreground on any OS,
  including macOS, whose launchd service cannot carry a tunnel.
</span>
{#if !gatewayStore.tunnelUrl}
  <span class="unavailable">This gateway did not report its tunnel URL. Replace the URL placeholder before running the command.</span>
{/if}

<style>
  code {
    background: var(--code-bg, rgba(127, 127, 127, .12));
    padding: .1em .35em;
    border-radius: 3px;
    font-size: .9em;
  }
  .tunnel-command {
    display: block;
    margin: .5rem 0;
    padding: .5rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .explanation, .unavailable {
    display: block;
    margin-bottom: .5rem;
  }
</style>
