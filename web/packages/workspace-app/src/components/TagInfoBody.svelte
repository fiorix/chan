<script lang="ts">
  // Inspector body for non-file graph nodes (tags, mentions, dates).
  // Lifted from the inline panel that GraphPanel renders for the same
  // node kinds, so search and graph hosts can share one component.
  //
  // Reads the document list from the global graph store (loaded
  // lazily via ensureGraphLoaded). Caller supplies the node id and a
  // navigate callback used when the user clicks a referencing
  // document.

  import {
    documentsReferencing,
    ensureGraphLoaded,
    graphData,
    type GraphViewNode,
  } from "../state/graphData.svelte";
  import { openGraphForMention, openGraphForTag } from "../state/store.svelte";
  import KindChip from "./KindChip.svelte";

  let {
    nodeId,
    label,
    kind,
    onNavigate,
    onSetAsScope,
    onOpen,
    documentsOverride,
  }: {
    nodeId: string;
    label: string;
    kind: "tag" | "mention" | "date";
    /// Click handler for a referencing document. Receives the doc's
    /// path. Hosts decide whether to open it in the active pane and
    /// close themselves; absent = entries render as non-clickable.
    onNavigate?: (path: string) => void;
    /// "Set as Scope" action. For tag kind: re-scope to the tag's
    /// neighbourhood. For mention kind: hosts that resolve the
    /// mention to a contact file scope to that file (e.g. clicking
    /// `alice` scopes the graph to `Contacts/Alice Chen.md`);
    /// otherwise the host scopes to the mention meta-node itself
    /// (`mention:@@Name`), so the button is available for any mention.
    onSetAsScope?: () => void;
    /// "Open" action. Set on mention/contact nodes when
    /// the host can resolve the mention to a real .md file; absent
    /// for tags / dates / unresolved mentions.
    onOpen?: () => void;
    /// Optional scope-filtered document list. When provided, this
    /// replaces the full-graph `documentsReferencing(nodeId)` lookup.
    /// GraphPanel passes its scope-filtered selectionEdges.documents
    /// so the tag inspector only lists docs visible in the rendered
    /// subgraph; search overlay leaves this unset for the full list.
    documentsOverride?: GraphViewNode[];
  } = $props();

  // Make sure the graph is loaded before we try to look up
  // referencing documents. ensureGraphLoaded is idempotent and
  // shared with GraphPanel / FileInfoBody, so this is essentially a
  // no-op once the user has touched any graph-aware surface.
  $effect(() => {
    void ensureGraphLoaded();
  });

  type FileGraphNode = Extract<GraphViewNode, { kind: "file" }>;
  const isContactNode = (d: GraphViewNode): d is FileGraphNode =>
    d.kind === "file" && d.node_kind === "contact";

  const documents = $derived<GraphViewNode[]>(
    documentsOverride ?? documentsReferencing(nodeId),
  );
  /// Split the referenced files into contacts vs plain docs so each
  /// kind can render under its own section header, mirroring
  /// FileInfoBody's Contacts / Links-to layout.
  const contacts = $derived<FileGraphNode[]>(documents.filter(isContactNode));
  const docs = $derived<GraphViewNode[]>(
    documents.filter((d) => !isContactNode(d)),
  );

  function navigate(node: GraphViewNode): void {
    if (node.kind !== "file" || !onNavigate) return;
    onNavigate(node.path);
  }
</script>

<div class="info">
  <header class="head">
    <KindChip
      {kind}
      block
      onClick={kind === "tag"
        ? () => openGraphForTag(nodeId, label)
        : kind === "mention"
          ? // A mention chip lands a mention-scoped graph
            // (`mention:@@Name`), NOT a tag scope. Routing it through
            // `openGraphForTag` would mint a bogus `tag:@@Name`.
            () => openGraphForMention(nodeId, label)
          : undefined}
    />
  </header>
  <h3 class="title">{kind === "mention" ? label.replace(/^@@/, "") : label}</h3>
  <div class="meta-grid">
    <span class="k">documents</span>
    <span class="v">{documents.length}</span>
  </div>
  {#if onOpen || (onSetAsScope && (kind === "tag" || kind === "mention"))}
    <div class="actions">
      {#if onOpen}
        <button class="set-as-scope" onclick={onOpen} type="button">
          Open
        </button>
      {/if}
      {#if onSetAsScope && (kind === "tag" || kind === "mention")}
        <button class="set-as-scope" onclick={onSetAsScope} type="button">
          Graph from here
        </button>
      {/if}
    </div>
  {/if}
  <!-- "Graph from here" lives in the inspector, not duplicated at
       the menu level. -->

  {#if !graphData.view && graphData.loading}
    <div class="muted">loading references...</div>
  {:else if graphData.error}
    <div class="err">references unavailable: {graphData.error}</div>
  {:else if documents.length === 0}
    <div class="muted">no documents reference this</div>
  {:else}
    {#if contacts.length > 0}
      <section class="refs">
        <h4>Contacts</h4>
        <ul>
          {#each contacts as d (d.id)}
            <li>
              {#if !d.missing && onNavigate}
                <button class="ref contact" onclick={() => navigate(d)}>{d.label}</button>
              {:else}
                <span class="ref contact" class:missing={d.missing}>{d.label}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if docs.length > 0}
      <section class="refs">
        <h4>Documents</h4>
        <ul>
          {#each docs as d (d.id)}
            <li>
              {#if d.kind === "file" && !d.missing && onNavigate}
                <button class="ref" onclick={() => navigate(d)}>{d.label}</button>
              {:else}
                <span
                  class="ref"
                  class:missing={d.kind === "file" && d.missing}
                >{d.label}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
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
  .title {
    margin: 0 0 0.5rem 0;
    font-size: 16px;
    font-weight: 600;
    word-break: break-word;
  }
  .actions {
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .set-as-scope {
    background: transparent;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 4px 8px;
    width: 100%;
  }
  .set-as-scope:hover {
    background: var(--hover-bg);
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 6.5em 1fr;
    gap: 2px 0.5rem;
    margin: 0.4rem 0 0.6rem 0;
    font-size: 14px;
  }
  .meta-grid .k { color: var(--text-secondary); }
  .meta-grid .v { color: var(--text); font-variant-numeric: tabular-nums; }
  .muted {
    color: var(--text-secondary);
    font-size: 13px;
    margin-top: 0.4rem;
    font-style: italic;
  }
  .err {
    color: var(--warn-text);
    font-size: 13px;
    margin-top: 0.4rem;
  }
  .refs { margin: 0.6rem 0 0 0; }
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
  .ref {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 13px;
    color: var(--text);
    cursor: default;
    font: inherit;
    line-height: 1.5;
    word-break: break-word;
  }
  button.ref { cursor: pointer; }
  button.ref:hover {
    border-color: var(--btn-hover);
    background: var(--hover-bg);
  }
  /* Contact rows: same person silhouette + warn-text accent as
     FileInfoBody's Contacts section. No left-border stripe (the
     icon + colour already mark the row), matching the file inspector. */
  .ref.contact {
    color: var(--warn-text);
    padding-left: 22px;
    position: relative;
  }
  .ref.contact::before {
    content: "";
    position: absolute;
    left: 6px;
    top: 50%;
    width: 12px;
    height: 12px;
    transform: translateY(-50%);
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='5' r='3'/><path d='M2 14c0-3 3-5 6-5s6 2 6 5z'/></svg>") center / contain no-repeat;
    mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='5' r='3'/><path d='M2 14c0-3 3-5 6-5s6 2 6 5z'/></svg>") center / contain no-repeat;
  }
  .ref.missing { color: var(--text-secondary); font-style: italic; }
</style>
