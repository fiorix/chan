<script lang="ts">
  // Find-on-page bar. Floats top-right of the editor canvas; one
  // per tab, mounted by FileEditorTab when `tab.find?.open` is set.
  // Host-driven only: the chan side binds no chord to opening
  // Find - browser users get Cmd+F natively, chan-desktop fires
  // `app.find.open` via the chan:command bridge.
  //
  // FindBar is the policy layer; both editor adapters are pure
  // imperative surfaces (FindAdapter in editor/find.ts). The bar
  // owns: debounce, currentIndex clamping across rescans, kbd
  // handling, and the highlight + scroll dispatch after every
  // mutation.

  import { onDestroy, tick } from "svelte";
  import { MAX_FIND_MATCHES, type FindAdapter, type FindRange } from "../editor/find";
  import {
    closeFind,
    setFindCaseSensitive,
    setFindCurrentIndex,
    setFindQuery,
    setFindResults,
    type FindState,
  } from "../state/tabs.svelte";

  let {
    find,
    adapter,
    docText,
    tabId,
  }: {
    find: FindState;
    adapter: FindAdapter | undefined;
    docText: string;
    tabId: string;
  } = $props();

  // Input ref for focus-on-mount + focus-back-on-mode-flip.
  let inputEl: HTMLInputElement | undefined = $state();

  // Debounce timer for rescan. Killed on every state change that
  // would re-trigger a scan; latest one wins.
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const SCAN_DEBOUNCE_MS = 150;

  function clamp(idx: number, len: number): number {
    if (len === 0) return -1;
    if (idx < 0) return 0;
    if (idx >= len) return len - 1;
    return idx;
  }

  /// Pick the new currentIndex after a rescan. Goal: keep the
  /// user looking at the same spot they were on. Strategy:
  ///   - if the previous current match has an identical-range
  ///     survivor in the new list, jump to it
  ///   - otherwise, land on the new match whose start offset is
  ///     closest to the previous current's start
  ///   - if there was no previous current (-1) or no matches,
  ///     return -1 / 0 appropriately
  function reanchorIndex(
    prevIdx: number,
    prevMatches: FindRange[],
    next: FindRange[],
  ): number {
    if (next.length === 0) return -1;
    if (prevIdx < 0 || prevIdx >= prevMatches.length) return 0;
    const prev = prevMatches[prevIdx]!;
    let best = 0;
    let bestDelta = Math.abs(next[0]!.from - prev.from);
    for (let i = 1; i < next.length; i++) {
      const d = Math.abs(next[i]!.from - prev.from);
      if (d < bestDelta) {
        best = i;
        bestDelta = d;
      }
    }
    return best;
  }

  function doScan(): void {
    if (!adapter) return;
    const prev = find.matches;
    const prevIdx = find.currentIndex;
    const next = adapter.scan(find.query, { caseSensitive: find.caseSensitive });
    setFindResults(find, next, reanchorIndex(prevIdx, prev, next), next.length >= MAX_FIND_MATCHES);
    adapter.highlightAll(next, find.currentIndex);
    if (find.currentIndex >= 0) adapter.scrollIntoView(find.currentIndex);
  }

  function scheduleScan(): void {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      doScan();
    }, SCAN_DEBOUNCE_MS);
  }

  // Re-scan whenever the query, the case-sensitivity flag, the
  // adapter (mode toggle), the doc text (edits / external reloads),
  // or the tab id changes. The tabId dependency is so a fresh
  // FindBar mount (different tab) treats its first scan as
  // immediate state, not a continuation.
  $effect(() => {
    // Read every dependency so Svelte tracks them.
    find.query;
    find.caseSensitive;
    docText;
    adapter;
    tabId;
    if (!find.open) return;
    if (!adapter) return;
    if (find.query === "") {
      // Empty query clears the highlight layer without touching
      // currentIndex (next typed char resumes near where it was).
      if (find.matches.length > 0) {
        setFindResults(find, [], -1, false);
        adapter.clearHighlights();
      }
      return;
    }
    scheduleScan();
  });

  // When currentIndex changes via prev/next, repaint + scroll.
  // Wrapped in untrack-ish via a previous-value memo so this
  // doesn't fight the scan effect (which also calls highlightAll).
  let lastPaintedIndex = -1;
  $effect(() => {
    if (!adapter) return;
    if (!find.open) return;
    if (find.currentIndex === lastPaintedIndex) return;
    lastPaintedIndex = find.currentIndex;
    if (find.matches.length === 0) return;
    if (find.currentIndex < 0) return;
    adapter.highlightAll(find.matches, find.currentIndex);
    adapter.scrollIntoView(find.currentIndex);
  });

  // Auto-focus the input on mount + whenever it comes back into
  // the DOM after a mode switch. `focusNonce` also bumps when the
  // bar is already open and the host sends app.find.open again.
  $effect(() => {
    if (!inputEl) return;
    // Touch find.open / tabId so the focus runs on every fresh
    // mount.
    find.open;
    tabId;
    find.focusNonce;
    void tick().then(() => {
      inputEl?.focus();
      if (find.query) inputEl?.select();
    });
  });

  onDestroy(() => {
    if (scanTimer) clearTimeout(scanTimer);
    adapter?.clearHighlights();
  });

  function goNext(): void {
    const n = find.matches.length;
    if (n === 0) return;
    setFindCurrentIndex(find, (Math.max(0, find.currentIndex) + 1) % n);
    adapter?.placeCursor(find.currentIndex);
  }
  function goPrev(): void {
    const n = find.matches.length;
    if (n === 0) return;
    const cur = find.currentIndex < 0 ? 0 : find.currentIndex;
    setFindCurrentIndex(find, (cur - 1 + n) % n);
    adapter?.placeCursor(find.currentIndex);
  }
  function close(): void {
    closeFind(tabId);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
      return;
    }
  }

  function onCaseToggle(): void {
    setFindCaseSensitive(find, !find.caseSensitive);
  }

  // Counter label. "10000+" when truncated; "0 of 0" with red
  // ring when query is set but produced nothing; "N of M"
  // otherwise; blank placeholder when query is empty.
  const counter = $derived.by(() => {
    if (find.query === "") return "";
    const n = find.matches.length;
    if (find.truncated) return `${find.currentIndex + 1} of ${MAX_FIND_MATCHES}+`;
    if (n === 0) return "0 of 0";
    return `${clamp(find.currentIndex, n) + 1} of ${n}`;
  });
  const noMatches = $derived(find.query !== "" && find.matches.length === 0);
  const stateMessage = $derived.by(() => {
    if (find.query === "") return "Empty search, type something";
    if (find.matches.length === 0) return "No matches in this document.";
    return "";
  });
</script>

<div class="find-bar" role="search" aria-label="find in document">
  <div class="find-row">
    <input
      bind:this={inputEl}
      bind:value={() => find.query, (query) => setFindQuery(find, query)}
      onkeydown={onKeydown}
      class="find-input"
      class:no-matches={noMatches}
      type="text"
      placeholder="Find in document"
      aria-label="find query"
      spellcheck="false"
      autocomplete="off"
    />
    <span class="find-counter" aria-live="polite">{counter}</span>
    <button
      class="find-btn"
      onclick={onCaseToggle}
      class:on={find.caseSensitive}
      title="match case"
      aria-label="match case"
      aria-pressed={find.caseSensitive}
    >Aa</button>
    <button
      class="find-btn"
      onclick={goPrev}
      disabled={find.matches.length === 0}
      title="previous match (Shift+Enter)"
      aria-label="previous match"
    >▲</button>
    <button
      class="find-btn"
      onclick={goNext}
      disabled={find.matches.length === 0}
      title="next match (Enter)"
      aria-label="next match"
    >▼</button>
    <button
      class="find-btn"
      onclick={close}
      title="close (Esc)"
      aria-label="close find bar"
    >×</button>
  </div>
  {#if stateMessage}
    <div class="find-state" aria-live="polite">{stateMessage}</div>
  {/if}
</div>

<style>
  .find-bar {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    padding: 4px 6px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    color: var(--text);
  }
  .find-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .find-input {
    width: 280px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    font: inherit;
    outline: none;
  }
  .find-input:focus {
    border-color: var(--accent, var(--btn-hover));
  }
  .find-input.no-matches {
    box-shadow: 0 0 0 1px #d33 inset;
  }
  .find-counter {
    min-width: 56px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    font-size: 12px;
    padding: 0 2px;
  }
  .find-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    padding: 3px 6px;
  }
  .find-btn:hover:not(:disabled) {
    background: var(--hover-bg);
    color: var(--text);
  }
  .find-btn.on {
    background: var(--hover-bg);
    color: var(--text);
  }
  .find-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .find-state {
    color: var(--text-secondary);
    font-size: 12px;
    padding: 1px 2px 0;
  }
</style>
