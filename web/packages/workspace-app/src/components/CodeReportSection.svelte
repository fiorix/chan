<!-- The Code section of a directory's inspector: the report's totals, its
     languages (the first few, the rest one click away) and the COCOMO
     estimate. A language's name is a button that hands the language to
     `onLanguageClick`.

     The section draws nothing above itself: the inspector body that mounts
     it sets the top margin and any divider, through a rule on `.code-report`,
     so the section sits among that body's other sections as one of them. -->
<script lang="ts">
  import type { ReportPrefix } from "../api/types";
  import { fmtDevs, fmtMonths } from "../state/format";

  let {
    report,
    onLanguageClick,
  }: {
    report: ReportPrefix;
    onLanguageClick: (language: string) => void;
  } = $props();

  /// "Top N + see more" toggle for the per-language list. Default of 5
  /// matches the inspector's appetite for compact sections; the full list
  /// is one click away. The expansion belongs to the report it was asked
  /// for, so a new report doesn't inherit the previous one's expand state.
  const LANG_PREVIEW = 5;
  let expandedFor = $state.raw<ReportPrefix | null>(null);
  const langExpanded = $derived(expandedFor === report);

  const visibleLanguages = $derived.by(() => {
    const all = report.by_language;
    if (langExpanded || all.length <= LANG_PREVIEW) return all;
    return all.slice(0, LANG_PREVIEW);
  });
  const hiddenLanguageCount = $derived(Math.max(0, report.by_language.length - visibleLanguages.length));
</script>

<section class="refs code-report">
  <h4>Code</h4>
  <div class="meta-grid">
    <span class="k">indexed</span>
    <span class="v">{report.totals.files}</span>
    <span class="k">SLOC</span>
    <span class="v">{report.totals.code.toLocaleString()}</span>
    <span class="k">comments</span>
    <span class="v">{report.totals.comments.toLocaleString()}</span>
    <span class="k">blanks</span>
    <span class="v">{report.totals.blanks.toLocaleString()}</span>
    <span class="k">complexity</span>
    <span class="v">{report.totals.complexity.toLocaleString()}</span>
  </div>
  {#if report.by_language.length > 0}
    <ul class="lang-list">
      {#each visibleLanguages as lang (lang.name)}
        <li class="lang-row">
          <button
            type="button"
            class="lang-name"
            title="open in graph (scoped to this language)"
            onclick={() => onLanguageClick(lang.name)}
          >{lang.name}</button>
          <span class="lang-files">{lang.files} file{lang.files === 1 ? "" : "s"}</span>
          <span class="lang-sloc">{lang.code.toLocaleString()} SLOC</span>
        </li>
      {/each}
    </ul>
    {#if hiddenLanguageCount > 0}
      <button
        type="button"
        class="see-more"
        onclick={() => (expandedFor = report)}
      >+{hiddenLanguageCount} more</button>
    {:else if langExpanded && report.by_language.length > LANG_PREVIEW}
      <button
        type="button"
        class="see-more"
        onclick={() => (expandedFor = null)}
      >show fewer</button>
    {/if}
  {/if}
  <!-- No estimated cost: the dollar number is a default-salary
       extrapolation that's noisy for a personal notes app. Effort,
       schedule, and developer-count carry the useful signal. -->
  <div class="cocomo">
    <div class="cocomo-title">COCOMO ({report.cocomo.model})</div>
    <div class="meta-grid">
      <span class="k">effort</span>
      <span class="v">{fmtMonths(report.cocomo.effort_person_months)}</span>
      <span class="k">schedule</span>
      <span class="v">{fmtMonths(report.cocomo.schedule_months)}</span>
      <span class="k">developers</span>
      <span class="v">{fmtDevs(report.cocomo.developers)}</span>
    </div>
  </div>
</section>

<style>
  /* The section's share of the inspector bodies' common rules: the key and
     value grid, the section heading and the list reset. */
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
  .refs h4 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0 0 0.25rem 0;
  }
  .refs ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .refs li { margin: 0; }
  /* Per-language row. Three columns: language name on the left (allowed
     to grow), file count + SLOC on the right (tabular-nums so the digit
     columns line up across rows). */
  .lang-list {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lang-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.5rem;
    font-size: 13px;
    align-items: baseline;
  }
  /* A <button> so the language name routes to the Graph (scoped to
     this language). Strip default button chrome, left-align, and add
     hover + focus affordance. Stays a grid cell at column 1. */
  .lang-name {
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
  .lang-name:hover { text-decoration: underline; }
  .lang-name:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .lang-files,
  .lang-sloc {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .see-more {
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
  .see-more:hover { text-decoration: underline; }
  .cocomo {
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px dashed var(--border);
  }
  .cocomo-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin-bottom: 0.2rem;
  }
  .cocomo .meta-grid {
    margin: 0;
  }
</style>
