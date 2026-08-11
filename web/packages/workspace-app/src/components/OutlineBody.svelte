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

  import { Eye, Play } from "lucide-svelte";
  import { groupHeadingsBySlides, parseSlidesSpec } from "../editor/slides";

  let {
    content,
    caretLine = null,
    onSelect,
    onPreview,
    onPlay,
    previewChord = "",
    playChord = "",
  }: {
    content: string;
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
  const slidePages = $derived(slidesSpec ? groupHeadingsBySlides(content, headings) : []);
  const activeIndex = $derived(computeActiveIndex(headings, caretLine));

  function computeActiveIndex(hs: Heading[], line: number | null): number | null {
    if (line == null || hs.length === 0) return null;
    let best: number | null = null;
    for (const h of hs) {
      if (h.line <= line) best = h.index;
      else break;
    }
    return best;
  }

  function parseHeadings(src: string): Heading[] {
    const out: Heading[] = [];
    let inFence = false;
    let fenceMarker = "";
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const fence = line.match(/^(```+|~~~+)/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1] ?? "";
        } else if (line.startsWith(fenceMarker)) {
          inFence = false;
          fenceMarker = "";
        }
        continue;
      }
      if (inFence) continue;
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
  <div class="slide-outline">
    {#each slidePages as page (page.number)}
      <section class="slide-page" aria-label={`Slide ${page.number} outline`}>
        <div
          class="slide-label"
          class:active-slide={page.headings.some((h) => h.index === activeIndex)}
        >
          Slide {page.number}
        </div>
        {#if page.headings.length === 0}
          <div class="slide-empty">No headings</div>
        {:else}
          <ul class="slide-heading-list">
            {#each page.headings as h (h.index)}
              <li class:active={h.index === activeIndex}>
                <button
                  class="row"
                  style="padding-left: {(h.depth - 1) * 14 + 14}px"
                  title={h.text}
                  onclick={() => onSelect(h)}
                >{h.text}</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>
{:else if headings.length === 0}
  <div class="empty">No headings yet</div>
{:else}
  <ul class="outline-list">
    {#each headings as h (h.index)}
      <li class:active={h.index === activeIndex}>
        <button
          class="row"
          style="padding-left: {(h.depth - 1) * 14 + 14}px"
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
    padding: 0.35rem 0 0.45rem;
  }
  .slide-page + .slide-page {
    margin-top: 0.25rem;
  }
  .slide-label {
    padding: 0.25rem 0.6rem 0.15rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.35;
  }
  .slide-label.active-slide {
    color: var(--text);
  }
  .slide-empty {
    margin-left: 10px;
    padding: 0.2rem 0.6rem 0.25rem;
    border-left: 1px solid var(--border);
    color: var(--text-secondary);
    font-style: italic;
  }
  /* Google-Docs-style outline, sitting in chan's left-side outline
     pane: every heading hangs off a single vertical guide line at
     the LEFT (toward the workspace edge), with items extending
     rightward. The line is the same colour as the panel border so
     it reads as structure, not decoration. Depth is encoded purely
     in left-padding; the line itself does not branch per level.
     The 10px gap between the line and the panel edge gives the
     tree breathing room from the pane chrome. */
  .outline-list,
  .slide-heading-list {
    list-style: none;
    margin: 0 0 0 10px;
    padding: 0.35rem 0;
    border-left: 1px solid var(--border);
  }
  .slide-heading-list {
    padding: 0.1rem 0 0.25rem;
  }
  li { position: relative; }
  /* Active-heading marker. The 2px accent bar sits on top of the
     ul's 1px guide line on the left edge (left: -1px overlaps by
     1px outward, the bar is 2px wide, so it fully covers the 1px
     guide and extends 1px further into the gutter). top/bottom =
     2px crop the bar to the row's vertical center. */
  li.active::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 2px;
    bottom: 2px;
    width: 2px;
    background: var(--link);
    border-radius: 1px;
  }
  li.active .row { color: var(--link); font-weight: 500; }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
    padding: 0.22rem 0.6rem;
    color: inherit;
    /* Use the editor theme's body family so the outline matches
       the document's typography. Size and weight are inherited
       from the inspector chrome so the outline reads as chrome,
       not as body text spilled into the side panel. */
    font-family: var(--chan-editor-body-family, inherit);
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 3px;
  }
  .row:hover { background: var(--hover-bg); }
</style>
