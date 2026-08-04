<script lang="ts">
  // Language inspector body. Shown when a language bubble
  // (`kind: "language"`, id `language:<lang>`) is selected in the
  // graph. Mirrors the other inspector bodies' chrome: a kind chip,
  // the language name, a small stats grid (files + lines of code),
  // and a "Graph from here" affordance.
  //
  // Below the stats the body fetches the language detail from
  // /api/graph/languages?language=<lang>: the COCOMO summary
  // chan-report computes for the language's file set, and the
  // complete ranked list of directories holding that language's code
  // (no graph-depth cutoff; the canvas depth slider only trims
  // rendered nodes). Directories page in five rows at a time via
  // "Load more"; clicking a row graphs from that directory.
  //
  // The action's semantic is host-decided (the callback-agnostic
  // pattern WorkspaceInfoBody / FileInfoBody already use): the graph
  // host re-scopes the current tab to the language lens, the file
  // browser host would spawn a fresh language graph. The body just
  // calls `onSetAsScope` / `onOpenDirectory`.

  import { api } from "../api/client";
  import type { LanguageGraphDetail } from "../api/types";

  /// Directory rows shown initially and added per "Load more" click.
  const DIR_PAGE = 5;

  let {
    language,
    label,
    files,
    code,
    onSetAsScope,
    onOpenDirectory,
  }: {
    language: string;
    label: string;
    files?: number;
    code?: number;
    /// "Graph from here" handler. When unset (e.g. a host that has
    /// no graph to re-scope) the button is suppressed.
    onSetAsScope?: () => void;
    /// Directory-row handler ("graph from there"). When unset the
    /// rows render as plain text instead of buttons.
    onOpenDirectory?: (path: string) => void;
  } = $props();

  let detail = $state<LanguageGraphDetail | null>(null);
  let detailError = $state(false);
  let dirShown = $state(DIR_PAGE);

  $effect(() => {
    // Refetch whenever the selected language changes. `stale` guards
    // the race where a fast language switch resolves the older
    // request after the newer one.
    const lang = language;
    detail = null;
    detailError = false;
    dirShown = DIR_PAGE;
    let stale = false;
    api
      .languageGraph({ language: lang })
      .then((res) => {
        if (!stale) detail = res.detail ?? null;
      })
      .catch(() => {
        if (!stale) detailError = true;
      });
    return () => {
      stale = true;
    };
  });

  const visibleDirectories = $derived((detail?.directories ?? []).slice(0, dirShown));
  const hiddenDirectoryCount = $derived((detail?.directories.length ?? 0) - dirShown);

  /// COCOMO formatting helpers; identical shape to WorkspaceInfoBody
  /// so every inspector formats the estimate the same way.
  function fmtMonths(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)} mo` : `${n.toFixed(1)} mo`;
  }
  function fmtDevs(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
  }
  function fmtCost(n: number): string {
    if (!Number.isFinite(n)) return " - ";
    return `$${Math.round(n).toLocaleString()}`;
  }
</script>

<div class="info">
  <header class="head">
    <span class="kind-chip language">language</span>
  </header>
  <h3 class="title" title={language}>{label}</h3>

  {#if onSetAsScope}
    <button class="open" type="button" onclick={onSetAsScope}>Graph from here</button>
  {/if}

  <div class="meta-grid">
    {#if files !== undefined}
      <span class="k">files</span>
      <span class="v">{files}</span>
    {/if}
    {#if code !== undefined}
      <span class="k">code lines</span>
      <span class="v">{code.toLocaleString()}</span>
    {/if}
  </div>

  {#if detail}
    <div class="cocomo">
      <div class="cocomo-title">COCOMO ({detail.cocomo.model})</div>
      <div class="meta-grid">
        <span class="k">effort</span>
        <span class="v">{fmtMonths(detail.cocomo.effort_person_months)}</span>
        <span class="k">schedule</span>
        <span class="v">{fmtMonths(detail.cocomo.schedule_months)}</span>
        <span class="k">developers</span>
        <span class="v">{fmtDevs(detail.cocomo.developers)}</span>
        <span class="k">cost</span>
        <span class="v">{fmtCost(detail.cocomo.estimated_cost_usd)}</span>
      </div>
    </div>

    {#if detail.directories.length > 0}
      <div class="dirs-title">Top directories</div>
      <ul class="dirs">
        {#each visibleDirectories as dir (dir.path)}
          <li class="dir-row">
            {#if onOpenDirectory}
              <button
                type="button"
                class="dir-name"
                title={dir.path || "/"}
                aria-label={dir.path || "/"}
                onclick={() => onOpenDirectory(dir.path)}
              >{dir.label}</button>
            {:else}
              <span class="dir-name-static" title={dir.path || "/"}>{dir.label}</span>
            {/if}
            <span class="dir-files">{dir.files} file{dir.files === 1 ? "" : "s"}</span>
            <span class="dir-sloc">{dir.code.toLocaleString()} SLOC</span>
          </li>
        {/each}
      </ul>
      {#if hiddenDirectoryCount > 0}
        <button
          type="button"
          class="load-more"
          onclick={() => (dirShown += DIR_PAGE)}
        >Load more</button>
      {/if}
    {/if}
  {:else if detailError}
    <div class="detail-error">language detail unavailable</div>
  {/if}
</div>

<style>
  .info {
    padding: 0.6rem 0.7rem 0.8rem 0.7rem;
    font-size: 12.5px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  /* Language kind chip: tracks the graph's language palette so the
     inspector cue matches the bubble colour on the canvas. Sits
     alongside the workspace / doc / contact / tag chips. */
  .kind-chip {
    color: #fff;
    text-transform: uppercase;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 3px;
    flex: 1;
    text-align: center;
  }
  .kind-chip.language {
    background: var(--g-language, #7c5cff);
    color: #fff;
  }
  .title {
    margin: 0 0 0.5rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 6.5em 1fr;
    gap: 2px 0.5rem;
    margin: 0.4rem 0 0.6rem 0;
    font-size: 14px;
  }
  .meta-grid .k { color: var(--text-secondary); }
  .meta-grid .v {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  /* Mirrors FileInfoBody / WorkspaceInfoBody `.open` so the
     "Graph from here" affordance reads consistently across bodies. */
  .open {
    width: 100%;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 5px 0;
    cursor: pointer;
    font: inherit;
    margin-top: 0.6rem;
  }
  .open:hover { border-color: var(--btn-hover); }
  .cocomo {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .cocomo-title {
    font-weight: 600;
    margin-bottom: 0.2rem;
  }
  .dirs-title {
    font-weight: 600;
    margin: 0.6rem 0 0.2rem 0;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }
  .dirs {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
  }
  .dir-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.5rem;
    align-items: baseline;
    padding: 1px 0;
  }
  .dir-name {
    color: var(--text);
    word-break: break-word;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }
  .dir-name:hover { text-decoration: underline; }
  .dir-name:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .dir-name-static {
    color: var(--text);
    word-break: break-all;
  }
  .dir-files,
  .dir-sloc {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .load-more {
    display: block;
    margin: 0.3rem 0 0 0;
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 0;
  }
  .load-more:hover { text-decoration: underline; }
  .detail-error {
    color: var(--text-secondary);
    font-style: italic;
    margin-top: 0.6rem;
  }
</style>
