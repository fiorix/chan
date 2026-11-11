<script lang="ts">
  // Privacy mode conceals the host name, chan home path and scan errors,
  // which may name files. The counts, rates and build name nobody.
  import PrivateField from "@chan/web-shared/PrivateField.svelte";
  import { metrics, watchMetrics } from "../state/metrics.svelte";
  import type { MetricSample } from "../api/metrics";
  import MetricChart from "./MetricChart.svelte";
  let { active = true }: { active?: boolean } = $props();
  let visible = $state(typeof document === "undefined" || !document.hidden);
  $effect(() => {
    const changed = () => { visible = !document.hidden; };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  });
  $effect(() => { if (active && visible) return watchMetrics(); });
  const view = $derived(metrics.view);
  const sample = $derived(view?.latest);
  const process = $derived(sample?.process);
  function bytes(value: number | null | undefined): string {
    if (value == null) return "n/a";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function rate(value: number | null | undefined): string { return value == null ? "n/a" : `${bytes(value)}/s`; }
  function uptime(value: number): string {
    const days = Math.floor(value / 86400);
    return `${days ? `${days}d ` : ""}${Math.floor(value % 86400 / 3600)}h ${Math.floor(value % 3600 / 60)}m ${Math.floor(value % 60)}s`;
  }
  function series(read: (sample: MetricSample) => number | null) { return metrics.samples.map((s) => ({ at: s.elapsedMs, value: read(s) })); }
  const channels = $derived(sample ? [
    { name: "HTTP/2", traffic: sample.http2 }, { name: "yamux", traffic: sample.yamux },
    { name: "Reverse TCP", traffic: sample.reverseConnections },
  ] : []);
</script>
<section class="metrics-slide" aria-label="Metrics">
  <header>
    <div><h2>Metrics</h2><p>Server process{view ? ` · PID ${view.identity.pid}` : ""}</p>{#if view}<p>Host: {#if view.identity.hostname}<PrivateField field="metrics:host" label="host name">{view.identity.hostname}</PrivateField>{:else}n/a{/if}</p>{/if}</div>
    {#if view}<div class="identity">chan {view.identity.version}<br /><code>{view.identity.build}</code></div>{/if}
  </header>
  {#if metrics.error}<p class="error" role="status">Metrics unavailable: {metrics.error}. Displayed readings may be stale.</p>{/if}
  {#if !sample}<p class="waiting">Waiting for server metrics...</p>{:else}
    <div class="summary"><span>Uptime <strong>{process ? uptime(process.uptimeSeconds) : "n/a"}</strong></span><span>1-second samples · up to 10 minutes</span></div>
    <div class="cards">
      <article><h3>CPU <strong>{process?.cpuPercent == null ? "n/a" : `${process.cpuPercent.toFixed(1)}%`}</strong></h3>
        <MetricChart label="CPU percent, one core equals 100%" values={series((s) => s.process?.cpuPercent ?? null)} /><p>100% = one logical core</p></article>
      <article><h3>Memory <strong>{bytes(process?.residentBytes)}</strong></h3>
        <MetricChart label="Resident memory in bytes" values={series((s) => s.process?.residentBytes ?? null)} /><p>Resident memory · excludes child processes</p></article>
      <article><h3>Network <strong>{rate(sample.network.receivedBytesPerSecond)}</strong></h3>
        <MetricChart label="Service transport receive bytes per second" values={series((s) => s.network.receivedBytesPerSecond)} /><p>RX · TX {rate(sample.network.sentBytesPerSecond)}</p></article>
      <article><h3>I/O read <strong>{rate(process?.readBytesPerSecond)}</strong></h3>
        <MetricChart label="Process I/O read bytes per second" values={series((s) => s.process?.readBytesPerSecond ?? null)} /><p>{bytes(process?.readBytes)} total · {process?.ioScope === "unavailable" ? "Unavailable on this platform" : process?.ioScope === "process_io" ? "all process I/O" : "storage I/O"}</p></article>
      <article><h3>I/O write <strong>{rate(process?.writtenBytesPerSecond)}</strong></h3>
        <MetricChart label="Process I/O write bytes per second" values={series((s) => s.process?.writtenBytesPerSecond ?? null)} /><p>{bytes(process?.writtenBytes)} total</p></article>
      <article><h3>File transfers <strong>{sample.transfers.running} running</strong></h3>
        <MetricChart label="Active file transfer worker jobs" values={series((s) => s.transfers.running)} /><p>{sample.transfers.queued}/{sample.transfers.queueCapacity} queued · {sample.transfers.workerCapacity} workers</p></article>
    </div>
    <div class="details">
      <article><h3>Channels &amp; tunnels</h3>
        <p>{sample.gatewayTunnels} gateway · {sample.reverseListeners} reverse listeners · {sample.tunnelDialFailures} dial failures</p>
        <table><thead><tr><th>Layer</th><th>Active</th><th>RX</th><th>TX</th></tr></thead>
          <tbody>{#each channels as channel}<tr><th>{channel.name}</th><td>{channel.traffic.active}</td><td>{rate(channel.traffic.receivedBytesPerSecond)}</td><td>{rate(channel.traffic.sentBytesPerSecond)}</td></tr>{/each}</tbody></table>
        <p>yamux: {sample.yamuxServing}/{sample.yamuxServiceCapacity} handlers · {sample.yamuxWaiting} waiting · {sample.yamuxStreamLimit} streams/tunnel</p>
        <p>Layer payloads overlap. Network counts service TCP/connector bytes.</p>
      </article>
      <article><h3>Storage <strong>{bytes(view?.storage.logicalBytes)}</strong></h3>
        <p class="path"><PrivateField field="metrics:chan-home" label="chan home path"><span title={view?.storage.path}>{view?.storage.path}</span></PrivateField></p>
        <p>{bytes(view?.storage.allocatedBytes)} allocated · {view?.storage.files ?? "n/a"} files</p>
        <p>{view?.storage.sampledAtMs ? `Scanned ${new Date(view.storage.sampledAtMs).toLocaleTimeString()}` : "Scan pending"} · refreshes every minute</p>
        {#if view?.storage.error}<p class="error">Storage scan failed: <PrivateField field="metrics:storage-error" label="storage scan error">{view.storage.error}</PrivateField>{view.storage.logicalBytes == null ? "." : "; showing the last completed total."}</p>{/if}
        <h3 class="transfer-heading">Transfer payload</h3>
        <p>RX {rate(sample.transferPayload.receivedBytesPerSecond)} · TX {rate(sample.transferPayload.sentBytesPerSecond)}</p>
        <p>{sample.transfers.finished} finished · {sample.transfers.cancelled} cancelled · {sample.transfers.stalled} stalled · {sample.transfers.panicked} panicked · {sample.transfers.refused} refused</p>
      </article>
    </div>
  {/if}
</section>
<style>
  /* Auto margins put the slide in the middle of the carousel's stage, a flex
     column, on both axes. They take only the room the stage has to spare: in
     a stage narrower or shorter than the slide they are zero, so the slide
     fills the width or shrinks to the height and its scroll starts at the
     first row. */
  .metrics-slide { width: 100%; max-width: 1120px; min-height: 0; margin: auto; overflow: auto; padding: 8px 18px 18px; box-sizing: border-box; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding-bottom: 18px; }
  h2 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
  h3 { display: flex; justify-content: space-between; gap: 8px; margin: 0 0 12px; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
  h3 strong { color: var(--text); font-size: 16px; font-variant-numeric: tabular-nums; }
  p { margin: 5px 0 0; font-size: 11px; line-height: 1.5; color: var(--text-secondary); }
  .identity { text-align: right; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  code { color: var(--text-secondary); font-size: 11px; }
  .summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-secondary); margin-bottom: 14px; }
  .summary strong { color: var(--text); font-weight: 500; margin-left: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 12px; }
  article { padding: 14px; border: 1px solid var(--border); border-radius: 8px; min-width: 0; }
  .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 12px 0; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 5px 0 5px 8px; font-weight: 400; white-space: nowrap; }
  th:first-child { text-align: left; padding-left: 0; }
  thead { color: var(--text-secondary); border-bottom: 1px solid var(--border); }
  .path { overflow-wrap: anywhere; }
  .error { color: var(--warn-text); margin: 0 0 12px; }
  .transfer-heading { margin-top: 20px; margin-bottom: 4px; }
  .waiting { padding: 32px 0; }
</style>
