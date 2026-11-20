<script lang="ts">
  // A connected devserver's connection face beside its name: the bars mark,
  // coloured by the face, and its words where the mark does not stand alone.
  // Privacy mode leaves it as it is: it names no machine and no place, and a
  // screen being shared may show how the connection is doing. The mark alone
  // is the image that carries the face's name, and its `id` lets a control
  // that holds the face, and whose own label replaces its content, name the
  // face as its description.
  import type { ConnectionHealth } from "../api/library";
  import { connectionFaceLabel, connectionFaceName } from "../lib/connectionHealth";

  let { health, now, id }: { health: ConnectionHealth; now: number; id?: string } = $props();

  const label = $derived(connectionFaceLabel(health, now));
  const name = $derived(connectionFaceName(health, now));
</script>

<span class="connection-face" data-face={health.face} title={name}>
  <span class="mark" {id} role="img" aria-label={name}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M2.5 11v2M6 8v5M9.5 5v8M13 2v11" />
    </svg>
  </span>
  {#if label}<span class="label">{label}</span>{/if}
</span>

<style>
  .connection-face {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    color: var(--text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .connection-face[data-face="unknown"] .mark { opacity: 0.5; }
  .connection-face[data-face="slow"] { color: var(--warn); }
  .connection-face[data-face="stalled"], .connection-face[data-face="reconnecting"] { color: var(--danger); }
  .mark { display: inline-flex; flex: none; }
  .mark svg { width: 14px; height: 14px; }
</style>
