<script lang="ts" module>
  /// One ATX heading recognized in the buffer. Stable index across a
  /// single parse so the editor's WYSIWYG side can stamp matching
  /// `data-heading-id="h-<index>"` attributes.
  export type Heading = {
    /// 0-indexed position in document order.
    index: number;
    /// 0-indexed source line number.
    line: number;
    depth: number; // 1..6
    text: string;
  };
</script>

<script lang="ts">
  // Outline body for the inspector: parses ATX headings from the
  // buffer and renders them as an indented clickable list. Used by
  // file editor tabs; the host (Inspector) provides the chrome.
  //
  // Heading detection is a single regex pass with state for fenced
  // code blocks (so `# foo` inside a ``` block doesn't pollute the
  // outline). Cheap; no debounce needed.

  import { tick } from "svelte";
  import { slidePreviewCss } from "../editor/slide_dom";
  import SlideThumbnail from "./SlideThumbnail.svelte";
  import { Eye, Play } from "lucide-svelte";
  import { fenceLineTracker } from "../editor/commands/fence";
  import { parseSlidesSpec, splitSlidePages, slideIndexForLine } from "../editor/slides";

  let {
    content,
    caretLine = null,
    onSelect,
    onPreview,
    onPlay,
    previewChord = "",
    playChord = "",
    fromPath = null,
    theme = "light",
  }: {
    content: string;
    fromPath?: string | null;
    theme?: "light" | "dark";
    /// 0-indexed source line the caret sits on. When provided, the
    /// outline highlights the most recent heading at or above that
    /// line as "active" (Google-Docs-style current-position marker).
    /// Null disables the marker.
    caretLine?: number | null;
    onSelect: (h: Heading) => void;
    onPreview?: () => void;
    onPlay?: () => void;
    /// Live chord labels for the slide-action button tooltips, resolved
    /// by the caller through `chordFor` so a user rebind is reflected.
    /// Empty when the action has no chord on this surface.
    previewChord?: string;
    playChord?: string;
  } = $props();

  const headings = $derived(parseHeadings(content));
  const slidesSpec = $derived(parseSlidesSpec(content));
  const slidePages = $derived(slidesSpec ? splitSlidePages(content) : []);
  const activeIndex = $derived(computeActiveIndex(headings, caretLine));

  const activeSlide = $derived(slideIndexForLine(slidePages, caretLine));
  let navigator = $state<HTMLElement>();

  $effect(() => {
    const index = slidesSpec ? activeSlide : activeIndex;
    void index;
    void tick().then(() => {
      const selected = navigator?.querySelector<HTMLElement>('[aria-current="true"]');
      if (!selected || !navigator) return;
      const row = selected.getBoundingClientRect(), bounds = navigator.getBoundingClientRect();
      if (row.top < bounds.top) navigator.scrollTop += row.top - bounds.top - 6;
      else if (row.bottom > bounds.bottom) navigator.scrollTop += row.bottom - bounds.bottom + 6;
    });
  });

  function slideStyles(node: HTMLElement) {
    const style = document.createElement("style");
    style.textContent = slidePreviewCss();
    node.append(style);
    return { destroy: () => style.remove() };
  }

  function selectSlide(index: number): void {
    const page = slidePages[index];
    if (!page) return;
    onSelect({ index, line: page.startLine, depth: 1, text: `Slide ${page.number}` });
  }

  function slideKey(event: KeyboardEvent, index: number): void {
    let next = index;
    if (event.key === "ArrowUp") next--;
    else if (event.key === "ArrowDown") next++;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = slidePages.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    next = Math.max(0, Math.min(slidePages.length - 1, next));
    selectSlide(next);
    navigator?.querySelectorAll<HTMLButtonElement>(".slide-thumb")[next]?.focus({ preventScroll: true });
  }

  function computeActiveIndex(hs: Heading[], line: number | null): number | null {
    if (line == null || hs.length === 0) return null;
    let best: number | null = null;
    for (const h of hs) {
      if (h.line <= line) best = h.index;
      else break;
    }
    return best;
  }

  /// The lines a leading YAML frontmatter block takes, 0 when there is none,
  /// by the editor's rule (`editor/markdown/frontmatter.ts`): line 0 is
  /// exactly `---`, and the block ends at the next line that is exactly
  /// `---` or `...` within 10,000 lines. With no closer there is no block,
  /// and the opener renders as a rule.
  function frontmatterLineCount(lines: string[]): number {
    if (lines[0]?.replace(/\r$/, "") !== "---") return 0;
    const last = Math.min(lines.length - 1, 10_000);
    for (let i = 1; i <= last; i++) {
      const line = lines[i]!.replace(/\r$/, "");
      if (line === "---" || line === "...") return i + 1;
    }
    return 0;
  }

  function parseHeadings(src: string): Heading[] {
    const out: Heading[] = [];
    const fence = fenceLineTracker();
    const lines = src.split("\n");
    // A `#` line inside frontmatter is a YAML comment, not a heading.
    for (let i = frontmatterLineCount(lines); i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (fence(line) !== "text") continue;
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!m) continue;
      out.push({
        index: out.length,
        line: i,
        depth: m[1]!.length,
        text: stripInlineMarkdown(m[2]!.trim()),
      });
    }
    return out;
  }

  /// Strip the common inline markdown markers from a heading's text
  /// so the outline renders as readable plain text. Order matters:
  /// `**bold**` runs first so `*x*` doesn't eat the inner `*` of a
  /// double-asterisk pair.
  function stripInlineMarkdown(text: string): string {
    return text
      // Bold ** ** and __ __
      .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
      .replace(/__([^_\n]+?)__/g, "$1")
      // Italic * * and _ _
      .replace(/(?<![*_])\*([^*\n]+?)\*(?![*_])/g, "$1")
      .replace(/(?<![_*])_([^_\n]+?)_(?![_*])/g, "$1")
      // Strikethrough ~~ ~~
      .replace(/~~([^~\n]+?)~~/g, "$1")
      // Inline code ` `
      .replace(/`([^`\n]+?)`/g, "$1")
      // Wikilinks [[target|label]] / [[target]] -> label or target
      .replace(/\[\[([^\[\]\n|]+?)\|([^\[\]\n]+?)\]\]/g, "$2")
      .replace(/\[\[([^\[\]\n]+?)\]\]/g, (_, body: string) => {
        const last = body.split("/").pop() ?? body;
        return last.replace(/\.md$/, "");
      })
      // Markdown links [label](url) -> label
      .replace(/\[([^\[\]\n]+?)\]\([^)\n]+?\)/g, "$1");
  }
</script>

{#if slidesSpec}
  <div class="slide-actions" aria-label="Slide actions">
    <button
      type="button"
      class="slide-action"
      title={`Preview slides (${slidesSpec.aspectRatio}${previewChord ? `, ${previewChord}` : ""})`}
      onclick={() => onPreview?.()}
    >
      <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>Preview</span>
    </button>
    <button
      type="button"
      class="slide-action"
      title={`Present slides (${slidesSpec.aspectRatio}${playChord ? `, ${playChord}` : ""})`}
      onclick={() => onPlay?.()}
    >
      <Play size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>Present</span>
    </button>
  </div>
{/if}

{#if slidesSpec}
  <nav class="slide-outline" aria-label="Slide thumbnails" bind:this={navigator} use:slideStyles>
    {#each slidePages as page, index (page.number)}
      <button type="button" class="slide-thumb" aria-current={index === activeSlide}
        aria-label={`Slide ${page.number}`} title={`Slide ${page.number}`} onclick={() => selectSlide(index)} onkeydown={(event) => slideKey(event, index)}>
        <span class="slide-number" aria-hidden="true">{page.number}</span>
        <SlideThumbnail markdown={page.markdown} spec={slidesSpec} {fromPath} {theme} />
      </button>
    {/each}
  </nav>
{:else if headings.length === 0}
  <div class="empty">No headings yet</div>
{:else}
  <ul class="outline-list" bind:this={navigator}>
    {#each headings as h (h.index)}
      <li class:active={h.index === activeIndex}>
        <button
          class="row"
          style="padding-left: {(h.depth - 1) * 14 + 14}px"
          aria-current={h.index === activeIndex}
          title={h.text}
          onclick={() => onSelect(h)}
        >{h.text}</button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .empty {
    padding: 0.5rem 0.6rem;
    color: var(--text-secondary);
    font-style: italic;
  }
  .slide-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.35rem;
    padding: 0.45rem 0.5rem 0.2rem;
  }
  .slide-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    min-width: 0;
    height: 1.8rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .slide-action:hover {
    background: var(--hover-bg);
  }
  .slide-action span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .slide-outline {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-gutter: stable;
    overscroll-behavior: contain;
    padding: 6px 16px 16px 8px;
  }
  .slide-thumb {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: start;
    gap: 7px;
    width: 100%;
    margin: 0 0 14px;
    padding: 3px 2px;
    border: 0;
    border-radius: 5px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .slide-number { color: var(--text-secondary); font-size: 11px; text-align: right; padding-top: 4px; font-variant-numeric: tabular-nums; }
  .slide-thumb[aria-current="true"] .slide-number { color: var(--link); font-weight: 700; }
  .slide-thumb[aria-current="true"] :global(.slide-miniature) { outline: 2px solid var(--link); outline-offset: 2px; }
  .slide-thumb:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
  .outline-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    list-style: none;
    margin: 0;
    padding: 6px 12px 14px 8px;
  }
  li { position: relative; }
  li.active { background: color-mix(in srgb, var(--link) 10%, transparent); border-radius: 4px; }
  li.active::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; background: var(--link); border-radius: 1px; }
  li.active .row { color: var(--link); font-weight: 500; }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
    padding: 8px 0.6rem;
    color: inherit;
    /* Use the editor theme's body family so the outline matches
       the document's typography. Size and weight are inherited
       from the inspector chrome so the outline reads as chrome,
       not as body text spilled into the side panel. */
    font-family: var(--chan-editor-body-family, inherit);
    font-size: inherit;
    font-weight: inherit;
    line-height: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 3px;
  }
  .row:hover { background: var(--hover-bg); }
</style>
