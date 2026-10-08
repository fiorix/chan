<script lang="ts">
  // What the Details inspector says for a workspace's draft. A draft is
  // kept outside the workspace: it has no entry in the tree to describe, no
  // place to reveal and nothing that reads the workspace's index, so the
  // file inspector's body does not apply to it. This one names the draft and
  // says where it stands. The graph shows it for a draft's node, and with a
  // title alone for the drafts group.

  import { displayPath } from "../api/fileIdentity";
  import { basename } from "../state/format";

  let {
    path = null,
    title = null,
    busy = false,
    onOpen,
  }: {
    /// A file of the draft, as its client path. Null where there is none to
    /// name: the drafts group, or a draft with no file to open yet.
    path?: string | null;
    /// The heading. A file's name when there is a path and no title.
    title?: string | null;
    /// A save or a discard of the draft is in flight.
    busy?: boolean;
    /// Offers Open, where the caller has a file to open.
    onOpen?: () => void;
  } = $props();

  // The path as a person reads it; the client path itself is never shown.
  const shown = $derived(path === null ? null : displayPath(path));
  const heading = $derived(title ?? (shown === null ? "Drafts" : basename(shown)));
</script>

<div class="info">
  <header class="head">
    <span class="drafts-chip">DRAFTS</span>
  </header>
  <h3 class="title" title={shown ?? heading}>{heading}</h3>
  <div class="drafts-notice" role="note">
    <strong>Drafts are kept outside the workspace.</strong>
    They are not in search or the graph until saved to the workspace. Save or discard a draft
    from its editor tab.
  </div>
  {#if busy}
    <div class="draft-busy">This draft is busy.</div>
  {/if}
  {#if shown !== null}
    <code class="draft-path">{shown}</code>
  {/if}
  {#if onOpen}
    <button type="button" class="draft-open" onclick={onOpen}>Open</button>
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
  .drafts-chip {
    flex: 1;
    color: #fff;
    background: var(--fb-drafts-fg);
    text-transform: uppercase;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 3px;
    text-align: center;
  }
  .title {
    margin: 0 0 0.5rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }
  .drafts-notice {
    margin: 0.5rem 0;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
    background: var(--fb-drafts-bg);
    border-left: 3px solid var(--fb-drafts-fg);
    font-size: 12.5px;
    color: var(--text);
    line-height: 1.45;
  }
  .drafts-notice strong {
    display: block;
    margin-bottom: 0.25rem;
  }
  .draft-path {
    display: block;
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .draft-busy {
    margin-bottom: 0.4rem;
    color: var(--text-secondary);
  }
  .draft-open {
    margin-top: 0.6rem;
    font-size: 12.5px;
  }
</style>
