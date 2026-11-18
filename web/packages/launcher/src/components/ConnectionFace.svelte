<script lang="ts">
  // A connected devserver's connection face beside its name: the bars mark,
  // coloured by the face, and its words where the mark does not stand alone.
  // In privacy mode the colour stays and the words go behind the
  // devserver's one connection reveal. The mark alone is the image that
  // carries the face's name: an image's children are not read, so the reveal
  // stands beside it. Its `id` lets a control that holds the face, and whose
  // own label replaces its content, name the face as its description.
  import PrivateField from "@chan/web-shared/PrivateField.svelte";
  import { privateText } from "@chan/web-shared/privacy";
  import type { ConnectionHealth } from "../api/library";
  import { connectionFaceLabel, connectionFaceName } from "../lib/connectionHealth";

  let { health, now, field, id }: { health: ConnectionHealth; now: number; field: string; id?: string } = $props();

  const label = $derived(connectionFaceLabel(health, now));
  const name = $derived(connectionFaceName(health, now));
</script>

<span class="connection-face" data-face={health.face} title={privateText(name, "Connection details")}>
  <span class="mark" {id} role="img" aria-label={privateText(name, "Connection details")}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M2.5 11v2M6 8v5M9.5 5v8M13 2v11" />
    </svg>
  </span>
  <PrivateField {field} label="connection details">{#if label}<span class="label">{label}</span>{/if}</PrivateField>
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
