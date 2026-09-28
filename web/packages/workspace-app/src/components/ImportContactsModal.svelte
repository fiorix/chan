<script lang="ts">
  // Wizard for importing contacts (Google Contacts CSV today; vCard /
  // Outlook can slot in behind a provider list later). Four steps:
  //
  //   1. Provider     pick the source format
  //   2. File         show export instructions + accept the .csv
  //   3. Directory    workspace-relative directory picker (or root)
  //   4. Confirm      kick off the multipart POST + show outcome
  //
  // The actual import call lives in api.importContacts; this
  // component is just the step machine + the visuals.

  import { api } from "../api/client";
  import { tree, refreshTree, importStatus } from "../state/store.svelte";
  import ModalShell from "./ModalShell.svelte";

  type Provider = { id: "google"; label: string; instructions: string };
  type Outcome = Awaited<ReturnType<typeof api.importContacts>>;

  let {
    open,
    defaultDir = "",
    onClose,
    onImported,
  }: {
    open: boolean;
    defaultDir?: string;
    onClose: () => void;
    onImported?: (destDir: string) => void;
  } = $props();

  const PROVIDERS: Provider[] = [
    {
      id: "google",
      label: "Google Contacts",
      instructions:
        "Open contacts.google.com, click Export, choose Google CSV, " +
        "then drop the downloaded file here.",
    },
  ];

  type Step = "provider" | "file" | "folder" | "confirm" | "done";
  let step = $state<Step>("provider");
  let provider = $state<Provider>(PROVIDERS[0]);
  let file = $state<File | null>(null);
  // Initialized empty; the open-effect below seeds it from
  // defaultDir each time the modal opens. Initializing directly
  // from the prop here would read its initial value only and miss
  // later prop changes.
  let destDir = $state("");
  let overwrite = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let result = $state<Outcome | null>(null);

  // Reset to step 1 every time the modal opens. Without this, a
  // user dismissing mid-wizard then reopening would land on the
  // last step they were on (with stale state).
  $effect(() => {
    if (open) {
      step = "provider";
      provider = PROVIDERS[0];
      file = null;
      destDir = defaultDir;
      overwrite = false;
      busy = false;
      error = null;
      result = null;
    }
  });

  // Directories only, deduped from tree.entries plus an explicit root.
  // tree.entries is the same source the file tree renders from, so
  // the picker stays in sync with whatever the user just created.
  const folderPaths = $derived.by(() => {
    void tree.entries;
    const set = new Set<string>();
    set.add(""); // workspace root
    for (const e of tree.entries) {
      if (e.is_dir) set.add(e.path);
      // A file deep in a/b/c.md implies a, a/b are directories even if
      // tree.entries doesn't carry explicit dir entries for them.
      const parts = e.path.split("/");
      parts.pop();
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        set.add(acc);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  });

  function onFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    file = f;
    if (f) error = null;
  }

  async function runImport(): Promise<void> {
    if (!file) {
      error = "no file selected";
      return;
    }
    busy = true;
    error = null;
    // Publish to the global status bar so the bottom-left pill
    // reflects that an import is running even if the user steps
    // away from this modal. Detail (counts, errors) stays here on
    // the modal's "done" step.
    importStatus.value = { label: `importing contacts from ${provider.label}...` };
    try {
      const r = await api.importContacts(file, destDir, {
        provider: provider.id,
        overwrite,
      });
      result = r;
      step = "done";
      // Refresh the file tree so the new notes show up under the
      // chosen directory without the user having to reopen the
      // browser.
      await refreshTree();
      onImported?.(destDir);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      importStatus.value = null;
    }
  }

  function next(): void {
    if (step === "provider") step = "file";
    else if (step === "file") step = "folder";
    else if (step === "folder") step = "confirm";
  }
  function back(): void {
    if (step === "file") step = "provider";
    else if (step === "folder") step = "file";
    else if (step === "confirm") step = "folder";
  }

  function close(): void {
    if (busy) return;
    onClose();
  }

  // Pretty-print a directory path for the picker. Empty path = root.
  function fmtFolder(p: string): string {
    return p === "" ? "/ (workspace root)" : p;
  }

  // Indent depth for the flat directory list. v1: one ridiculously
  // simple tree-shape signal; a real tree picker can replace this.
  function depth(p: string): number {
    return p === "" ? 0 : p.split("/").length;
  }
</script>

{#if open}
  <ModalShell labelledby="import-contacts-title" onClose={close} gap="0.75rem">
    <div class="wizard">
      <div class="hd">
        <span id="import-contacts-title" class="title">Import contacts</span>
        <span class="step">step {stepNumber(step)} of 4</span>
      </div>

      {#if step === "provider"}
        <div class="body">
          <div class="hint">Choose where the contacts come from.</div>
          <ul class="picker">
            {#each PROVIDERS as p}
              <li>
                <button
                  class="row"
                  class:selected={provider.id === p.id}
                  onclick={() => (provider = p)}
                >
                  <span class="dot"></span>
                  <span class="lab">{p.label}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {:else if step === "file"}
        <div class="body">
          <div class="hint">{provider.instructions}</div>
          <input
            type="file"
            accept=".csv,text/csv,application/vnd.ms-excel"
            onchange={onFile}
          />
          {#if file}
            <div class="picked">
              Selected: <strong>{file.name}</strong> ({fmtBytes(file.size)})
            </div>
          {/if}
        </div>
      {:else if step === "folder"}
        <div class="body">
          <div class="hint">
            Where should the contact notes land? Type a directory
            name (it will be created if missing) or pick from
            below. Empty = workspace root.
          </div>
          <input
            class="folder-input"
            type="text"
            bind:value={destDir}
            placeholder="Contacts"
            spellcheck="false"
            autocomplete="off"
          />
          {#if folderPaths.length > 0}
            <ul class="picker folders">
              {#each folderPaths as p}
                <li>
                  <button
                    class="row"
                    class:selected={destDir === p}
                    style="padding-left: {0.5 + depth(p) * 0.75}rem"
                    onclick={() => (destDir = p)}
                  >
                    <span class="dot"></span>
                    <span class="lab">{fmtFolder(p)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          <label class="ow">
            <input type="checkbox" bind:checked={overwrite} />
            Replace existing files in this directory
          </label>
        </div>
      {:else if step === "confirm"}
        <div class="body">
          <div class="hint">Ready to import.</div>
          <dl class="kv">
            <dt>Source</dt>
            <dd>{provider.label}</dd>
            <dt>File</dt>
            <dd>{file?.name ?? "(none)"}</dd>
            <dt>Destination</dt>
            <dd>{fmtFolder(destDir)}</dd>
            <dt>On collision</dt>
            <dd>{overwrite ? "overwrite" : "skip existing"}</dd>
          </dl>
          {#if error}
            <div class="error">{error}</div>
          {/if}
        </div>
      {:else if step === "done" && result}
        <div class="body">
          <div class="hint">
            Imported into <strong>{fmtFolder(destDir)}</strong>.
          </div>
          <div class="counts">
            <span>{result.wrote.length} wrote</span>
            <span>{result.overwrote.length} overwrote</span>
            <span>{result.skipped.length} skipped</span>
            <span class:bad={result.failed.length > 0}>
              {result.failed.length} failed
            </span>
          </div>
          {#if result.failed.length > 0}
            <details class="fails">
              <summary>Failures</summary>
              <ul>
                {#each result.failed as f}
                  <li><strong>{f.name}</strong>: {f.reason}</li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if result.skipped.length > 0}
            <details class="fails">
              <summary>Skipped (already existed)</summary>
              <ul>
                {#each result.skipped as s}
                  <li>{s.path}</li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if result.warnings.length > 0}
            <!-- Non-fatal: parts of the request the server
                 ignored (typically an unknown multipart field).
                 Surface so a typo on the wire doesn't get swallowed
                 silently; the import itself still succeeded. -->
            <details class="fails warn" open>
              <summary>Warnings</summary>
              <ul>
                {#each result.warnings as w}
                  <li>{w}</li>
                {/each}
              </ul>
            </details>
          {/if}
        </div>
      {/if}

      <div class="actions">
        {#if step === "done"}
          <button class="ok" onclick={close}>Done</button>
        {:else}
          <button class="cancel" disabled={busy} onclick={close}>Cancel</button>
          {#if step !== "provider"}
            <button class="cancel" disabled={busy} onclick={back}>Back</button>
          {/if}
          {#if step !== "confirm"}
            <button
              class="ok"
              disabled={!canAdvance(step, file)}
              onclick={next}
            >Next</button>
          {:else}
            <button class="ok" disabled={busy} onclick={runImport}>
              {busy ? "Importing..." : "Import"}
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </ModalShell>
{/if}

<script lang="ts" module>
  function stepNumber(s: string): number {
    return s === "provider"
      ? 1
      : s === "file"
        ? 2
        : s === "folder"
          ? 3
          : 4;
  }
  function canAdvance(s: string, file: File | null): boolean {
    if (s === "provider") return true;
    if (s === "file") return file !== null;
    if (s === "folder") return true;
    return false;
  }
  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<style>
  .wizard {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 96px);
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .hd {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .title { font-weight: 600; }
  .step { color: var(--text-secondary); font-size: 12px; }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    overflow: auto;
    min-height: 0;
  }
  .hint { color: var(--text-secondary); font-size: 13px; }
  .picker {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: auto;
    max-height: 280px;
    background: var(--bg);
  }
  .picker.folders { max-height: 320px; }
  .picker li { border-bottom: 1px solid var(--border); }
  .picker li:last-child { border-bottom: none; }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover { background: var(--btn-bg); }
  .row.selected { background: var(--btn-hover); }
  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: transparent;
    flex-shrink: 0;
  }
  .row.selected .dot { background: var(--link); border-color: var(--link); }
  .lab { flex: 1; }
  .picked { font-size: 13px; color: var(--text-secondary); }
  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
  }
  .kv dt { color: var(--text-secondary); font-size: 13px; }
  .kv dd { margin: 0; }
  .ow { display: flex; align-items: center; gap: 0.4rem; font-size: 13px; }
  .counts { display: flex; gap: 1rem; font-size: 14px; }
  .counts .bad { color: var(--err, #d33); }
  .fails summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
  .fails ul { margin: 0.4rem 0 0 1rem; padding: 0; font-size: 13px; }
  .fails.warn summary { color: var(--warn, #c80); }
  .error { color: var(--err, #d33); font-size: 13px; }
  input[type="file"] {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    font: inherit;
  }
  .folder-input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    font: inherit;
    outline: none;
  }
  .folder-input:focus { border-color: var(--link); }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .actions button:hover:not([disabled]) { border-color: var(--btn-hover); }
  .actions button[disabled] { opacity: 0.5; cursor: default; }
  .actions .ok {
    background: var(--link);
    border-color: var(--link);
    color: #fff;
  }
</style>
