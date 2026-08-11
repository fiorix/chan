<script lang="ts">
  // Index status + rebuild for the "This workspace" settings tab. Shows the
  // live indexer state (chunks/vectors/model when idle, progress while
  // building/reindexing) and offers an explicit rebuild. The status poller is
  // owned here and cleared in onDestroy, so polling stops the moment the tab
  // unmounts (the SettingsOverlay mounts only the active section).

  import { onDestroy, onMount, untrack } from "svelte";
  import { api } from "../../../api/client";
  import { indexStatus } from "../../../state/store.svelte";
  import SettingField from "../SettingField.svelte";

  let mounted = $state(false);
  let indexResetting = $state(false);
  let indexResetError = $state<string | null>(null);
  let statusPollTimer: ReturnType<typeof setTimeout> | null = null;

  function fmt(n: number): string {
    return n.toLocaleString();
  }

  function stopStatusPoll(): void {
    if (statusPollTimer) {
      clearTimeout(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function scheduleStatusPoll(delayMs = 1500): void {
    stopStatusPoll();
    statusPollTimer = setTimeout(() => {
      statusPollTimer = null;
      void refreshIndexStatus();
    }, delayMs);
  }

  async function refreshIndexStatus(): Promise<void> {
    if (!mounted) return;
    try {
      const s = await api.indexStatus();
      indexStatus.value = s;
      scheduleStatusPoll(s.state === "idle" ? 5000 : 1000);
    } catch {
      indexStatus.value = null;
      scheduleStatusPoll(5000);
    }
  }

  async function rebuildIndex(): Promise<void> {
    indexResetting = true;
    indexResetError = null;
    try {
      await api.indexRebuild();
      indexStatus.value = { state: "reindexing", file: "" };
      scheduleStatusPoll(250);
    } catch (e) {
      indexResetError = (e as Error).message;
    } finally {
      indexResetting = false;
    }
  }

  onMount(() => {
    mounted = true;
    // untrack so the initial kick-off does not register reactive deps; the
    // poller re-arms itself off its own setTimeout chain.
    untrack(() => {
      void refreshIndexStatus();
      scheduleStatusPoll(0);
    });
  });

  onDestroy(() => {
    mounted = false;
    stopStatusPoll();
  });
</script>

<SettingField label="Index">
  <div class="stack">
    <div class="grid">
      <span class="k">state</span>
      <span class="v">{indexStatus.value?.state ?? "n/a"}</span>
      {#if indexStatus.value?.state === "idle"}
        <span class="k">chunks</span>
        <span class="v">{fmt(indexStatus.value.indexed_docs)}</span>
        <span class="k">vectors</span>
        <span class="v">{fmt(indexStatus.value.indexed_vectors)}</span>
        <span class="k">model</span>
        <span class="v mono">{indexStatus.value.model}</span>
      {:else if indexStatus.value?.state === "building"}
        <span class="k">progress</span>
        <span class="v">{fmt(indexStatus.value.current)} / {fmt(indexStatus.value.total)}</span>
        <span class="k">file</span>
        <span class="v mono path">{indexStatus.value.file}</span>
      {:else if indexStatus.value?.state === "reindexing"}
        <span class="k">file</span>
        <span class="v mono path">{indexStatus.value.file}</span>
      {:else if indexStatus.value?.state === "error"}
        <span class="k">error</span>
        <span class="v err">{indexStatus.value.message}</span>
      {/if}
    </div>
    <button class="action" onclick={() => void rebuildIndex()} disabled={indexResetting}>
      {indexResetting ? "Rebuilding..." : "Rebuild index"}
    </button>
    {#if indexResetError}
      <p class="hint err" role="alert">{indexResetError}</p>
    {/if}
  </div>
</SettingField>

<style>
  .action {
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    align-self: flex-start;
  }
  .action:hover:not(:disabled) {
    border-color: var(--btn-hover);
  }
  .action:disabled {
    opacity: 0.55;
    cursor: default;
  }
</style>
