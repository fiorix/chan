<script lang="ts">
  // Standalone graph tuner. Runs without the chan server: synthetic data
  // fed into the REAL production renderer (components/GraphCanvas.svelte),
  // with the graph's d3-force parameters (../graph/force.ts) exposed as
  // live sliders.
  //
  // Because this mounts the actual GraphCanvas (not a re-implementation),
  // whatever you see here is exactly what the live Graph tab does. The
  // slider values map 1:1 onto `DEFAULT_FORCE` in src/graph/force.ts: dial
  // a look you like, hit "Copy FORCE", and paste it back into that file to
  // ship it to the live graph.

  import GraphCanvas from "../components/GraphCanvas.svelte";
  import { DEFAULT_FORCE, type GraphForce } from "../graph/force";
  import { FS_GRAPH_DEPTH_MAX, relativeDepth } from "../graph/depth";
  import {
    defaultSpec, makeTunerGraph,
    type GraphSpec, type TunerEdge, type TunerGraph, type TunerNode,
  } from "./fakeData";
  // Real-graph fixture: GET /api/graph on a workspace seeded with this
  // repo's own source (1361 nodes / 2636 edges), captured to a static
  // file so the tuner has a realistic sample without a running server.
  // Loaded via ?raw + JSON.parse so the ~380 KB literal never enters the
  // type-checker. Edges use short keys (s/t/k/b) and files/media drop the
  // redundant `path` (== id); both are expanded below.
  import sampleGraphRaw from "./sampleGraph.json?raw";

  // ---- data sources -----------------------------------------------------

  type RawNode = {
    kind: string; id: string; label: string; path?: string;
    files?: number; code?: number; language?: string;
    node_kind?: "contact"; missing?: boolean;
  };
  type RawEdge = { s: string; t: string; k: string; b?: number };
  const RENDERED_EDGE_KINDS = new Set(
    ["link", "tag", "mention", "contains", "language", "group"],
  );

  // Map the server's GraphView shape onto what GraphCanvas consumes:
  // the same remap GraphPanel does in the app: directory -> folder,
  // media -> file, drop date/unknown; edges keep link/tag/mention/
  // contains/language.
  function mapSample(raw: { nodes: RawNode[]; edges: RawEdge[] }): TunerGraph {
    const nodes: TunerNode[] = [];
    for (const n of raw.nodes) {
      const path = n.path ?? n.id; // files/media: id==path; root folder: ""
      if (n.kind === "directory" || n.kind === "folder") {
        nodes.push({ kind: "folder", id: n.id, label: n.label, path, files: n.files ?? 0, code: n.code ?? 0 });
      } else if (n.kind === "media" || n.kind === "file") {
        nodes.push({
          kind: "file", id: n.id, label: n.label, path,
          ...(n.node_kind ? { node_kind: n.node_kind } : {}),
          ...(n.missing ? { missing: true } : {}),
        });
      } else if (n.kind === "tag" || n.kind === "mention") {
        nodes.push({ kind: n.kind, id: n.id, label: n.label });
      } else if (n.kind === "language") {
        nodes.push({ kind: "language", id: n.id, label: n.label, language: n.language ?? n.label, files: n.files ?? 0, code: n.code ?? 0 });
      }
    }
    const edges: TunerEdge[] = [];
    for (const e of raw.edges) {
      if (!RENDERED_EDGE_KINDS.has(e.k)) continue;
      const kind = e.k as TunerEdge["kind"];
      edges.push(e.b ? { source: e.s, target: e.t, kind, broken: true } : { source: e.s, target: e.t, kind });
    }
    return { nodes, edges };
  }

  const chanGraph: TunerGraph = mapSample(JSON.parse(sampleGraphRaw));

  // ---- tunable state ----------------------------------------------------

  let force = $state<GraphForce>({ ...DEFAULT_FORCE });
  let spec = $state<GraphSpec>({ ...defaultSpec });
  let dataSource = $state<"chan" | "synthetic">("chan");
  /// Filesystem depth cutoff, mirroring the Graph tab's workspace-scope
  /// depth slider: at depth D every file/dir whose path is within D
  /// levels of the root shows, plus the tags / mentions / languages
  /// attached to a visible node. Starts high so the full graph shows;
  /// clamped to the active graph's max depth.
  let depth = $state(99);
  let uiTheme = $state<"dark" | "light">("dark");
  /// Where the workspace-root node is pinned. "center"/"bottom" pin it
  /// (matching the Graph tab / Dashboard slide); "none" lets the whole
  /// cluster bbox-center with no anchor.
  let rootAnchor = $state<"center" | "bottom" | "none">("bottom");
  let selectedId = $state<string | null>(null);
  let copied = $state(false);

  const activeGraph: TunerGraph = $derived(
    dataSource === "chan" ? chanGraph : makeTunerGraph(spec),
  );

  /// Path-depth of a node: workspace root = 0, top-level = 1, nested = n.
  /// Non-hierarchical kinds (tag / mention / language) have no path, so
  /// they return Infinity and ride in only when linked to a visible node.
  function nodeDepth(n: TunerNode): number {
    if (n.kind === "tag" || n.kind === "mention" || n.kind === "language") return Infinity;
    if (n.kind === "folder" && (n.id === "" || n.path === "")) return 0;
    const path = n.kind === "folder" || n.kind === "file" ? n.path : "";
    return relativeDepth("", path);
  }

  // Cap at FS_GRAPH_DEPTH_MAX to match chan's workspace-scope depth
  // slider: GraphPanel fetches + caps the fs-graph at that depth
  // (graph/depth graphDepthCap), so the app can't reveal past it. The raw
  // tree may be deeper (the chan-source sample reaches 8), but the tuner
  // tracks whatever the app actually allows.
  const maxDepth: number = $derived.by(() => {
    let m = 1;
    for (const n of activeGraph.nodes) {
      const d = nodeDepth(n);
      if (d !== Infinity && d > m) m = d;
    }
    return Math.min(m, FS_GRAPH_DEPTH_MAX);
  });
  const effDepth: number = $derived(Math.min(depth, maxDepth));

  // Depth-limited visibility. GraphCanvas takes the FULL node/edge set
  // plus the visible subset (it filters + preserves positions), same as
  // GraphPanel; the depth slider drives the subset.
  const visible: { ids: Set<string>; edges: TunerEdge[] } = $derived.by(() => {
    const dep = new Map<string, number>();
    for (const n of activeGraph.nodes) dep.set(n.id, nodeDepth(n));
    const ids = new Set<string>();
    for (const n of activeGraph.nodes) {
      const d = dep.get(n.id) ?? Infinity;
      if (d !== Infinity && d <= effDepth) ids.add(n.id);
    }
    // Pull in tag / mention / language nodes attached to a visible node.
    for (const e of activeGraph.edges) {
      if (dep.get(e.source) === Infinity && ids.has(e.target)) ids.add(e.source);
      if (dep.get(e.target) === Infinity && ids.has(e.source)) ids.add(e.target);
    }
    const edges = activeGraph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { ids, edges };
  });
  const visibleNodeIds: Set<string> = $derived(visible.ids);
  const focalIds: string[] = $derived(rootAnchor === "none" ? [] : [""]);
  const focalAnchor: "center" | "bottom" = $derived(
    rootAnchor === "bottom" ? "bottom" : "center",
  );

  // Drive the theme the same way the app does: data-theme on <html>.
  // GraphCanvas's MutationObserver re-reads the CSS vars on the flip.
  $effect(() => {
    document.documentElement.setAttribute("data-theme", uiTheme);
  });

  // ---- FORCE sliders ----------------------------------------------------

  type SliderDef = {
    key: keyof GraphForce;
    label: string;
    min: number;
    max: number;
    step: number;
    hint: string;
  };
  // Order matches DEFAULT_FORCE so the copied literal reads the same.
  const SLIDERS: SliderDef[] = [
    { key: "chargeStrength", label: "Charge (repulsion)", min: -600, max: 0, step: 5, hint: "forceManyBody; more negative spreads the cluster" },
    { key: "linkDistance", label: "Link distance", min: 10, max: 220, step: 1, hint: "target length of wiki/markdown link edges" },
    { key: "linkDistanceTag", label: "Link distance · light edges", min: 10, max: 220, step: 1, hint: "tag / mention / contains / language / group edges" },
    { key: "linkStrength", label: "Link strength", min: 0, max: 2, step: 0.01, hint: "spring stiffness on every edge" },
    { key: "collidePad", label: "Collide padding", min: 0, max: 24, step: 0.5, hint: "extra gap added to each node radius" },
    { key: "velocityDecay", label: "Velocity decay", min: 0.05, max: 0.95, step: 0.01, hint: "friction; higher settles faster" },
    { key: "centerStrength", label: "Center strength", min: 0, max: 0.5, step: 0.005, hint: "pull toward x=0 (holds floaters in)" },
    { key: "hierarchyYSpacing", label: "Hierarchy Y spacing", min: 0, max: 300, step: 5, hint: "vertical gap between filesystem depth bands" },
    { key: "hierarchyYStrength", label: "Hierarchy Y strength", min: 0, max: 1, step: 0.01, hint: "how hard nodes snap to their depth band" },
    { key: "parentXStrength", label: "Parent X strength", min: 0, max: 1, step: 0.01, hint: "pull toward parent dir's X (clusters siblings)" },
  ];

  // Reassign a NEW object each change so GraphCanvas's reference compare
  // fires and the sim rebuilds. Mutating in place would keep the same
  // reference and no-op.
  function updateForce(key: keyof GraphForce, value: number): void {
    force = { ...force, [key]: value };
  }

  function resetForce(): void {
    force = { ...DEFAULT_FORCE };
  }

  function fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }

  // The paste-ready literal for src/graph/force.ts.
  const forceLiteral = $derived(
    "{\n" +
      SLIDERS.map((s) => `  ${s.key}: ${fmt(force[s.key])},`).join("\n") +
      "\n}",
  );

  async function copyForce(): Promise<void> {
    try {
      await navigator.clipboard.writeText(forceLiteral);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  // ---- dataset controls -------------------------------------------------

  type SpecSliderDef = { key: keyof GraphSpec; label: string; min: number; max: number; step: number };
  const SPEC_SLIDERS: SpecSliderDef[] = [
    { key: "linkDensity", label: "Link density", min: 0, max: 0.3, step: 0.005 },
    { key: "tagsPerDoc", label: "Tags / doc", min: 0, max: 6, step: 0.1 },
    { key: "mentionsPerDoc", label: "Mentions / doc", min: 0, max: 4, step: 0.1 },
  ];
  function updateSpec(key: keyof GraphSpec, value: number): void {
    spec = { ...spec, [key]: value };
  }
  function regenerate(): void {
    spec = { ...spec, seed: spec.seed + 1 };
  }

  const legend: { color: string; label: string }[] = [
    { color: "var(--g-doc)", label: "markdown" },
    { color: "var(--g-source)", label: "source" },
    { color: "var(--g-binary)", label: "binary" },
    { color: "var(--g-img)", label: "media" },
    { color: "var(--g-contact)", label: "contact / mention" },
    { color: "var(--g-tag)", label: "tag" },
    { color: "var(--g-language)", label: "language" },
    { color: "var(--g-folder)", label: "folder" },
    { color: "var(--fb-drafts-fg)", label: "drafts" },
  ];
</script>

<div class="tuner">
  <aside class="panel">
    <header class="panel-head">
      <h1>graph tuner</h1>
      <p class="sub">live <code>GraphCanvas</code> · values map 1:1 to <code>src/graph/force.ts</code></p>
    </header>

    <section>
      <div class="section-head"><h2>Data</h2></div>
      <label class="row inline">
        <span class="name">Source</span>
        <select value={dataSource} onchange={(e) => (dataSource = e.currentTarget.value as typeof dataSource)}>
          <option value="chan">chan source (real)</option>
          <option value="synthetic">synthetic</option>
        </select>
      </label>
      <label class="row" title="Filesystem depth (directory expansion), like the Graph tab's workspace-scope depth slider">
        <span class="name">Depth</span>
        <span class="val">{effDepth} / {maxDepth}</span>
        <input
          type="range"
          min="1"
          max={maxDepth}
          step="1"
          value={effDepth}
          oninput={(e) => (depth = +e.currentTarget.value)}
        />
      </label>
      <p class="note">{visible.ids.size} / {activeGraph.nodes.length} nodes · {visible.edges.length} / {activeGraph.edges.length} edges</p>
    </section>

    <section>
      <div class="section-head">
        <h2>Force</h2>
        <button class="ghost" onclick={resetForce}>Reset</button>
      </div>
      {#each SLIDERS as s (s.key)}
        <label class="row" title={s.hint}>
          <span class="name">{s.label}</span>
          <span class="val">{fmt(force[s.key])}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={force[s.key]}
            oninput={(e) => updateForce(s.key, +e.currentTarget.value)}
          />
        </label>
      {/each}
    </section>

    <section>
      <div class="section-head">
        <h2>Copy</h2>
        <button class="primary" onclick={copyForce}>{copied ? "Copied ✓" : "Copy FORCE"}</button>
      </div>
      <pre class="literal">{forceLiteral}</pre>
      <p class="note">Paste into <code>DEFAULT_FORCE</code> in <code>src/graph/force.ts</code>.</p>
    </section>

    {#if dataSource === "synthetic"}
      <section>
        <div class="section-head">
          <h2>Synthetic dataset</h2>
          <button class="ghost" onclick={regenerate}>Regenerate</button>
        </div>
        <label class="row inline">
          <span class="name">Seed</span>
          <input
            class="num"
            type="number"
            value={spec.seed}
            oninput={(e) => updateSpec("seed", Math.trunc(+e.currentTarget.value) || 0)}
          />
        </label>
        {#each SPEC_SLIDERS as s (s.key)}
          <label class="row">
            <span class="name">{s.label}</span>
            <span class="val">{fmt(spec[s.key])}</span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={spec[s.key]}
              oninput={(e) => updateSpec(s.key, +e.currentTarget.value)}
            />
          </label>
        {/each}
      </section>
    {/if}

    <section>
      <div class="section-head"><h2>View</h2></div>
      <label class="row inline">
        <span class="name">Theme</span>
        <button class="ghost" onclick={() => (uiTheme = uiTheme === "dark" ? "light" : "dark")}>
          {uiTheme}
        </button>
      </label>
      <label class="row inline">
        <span class="name">Root anchor</span>
        <select value={rootAnchor} onchange={(e) => (rootAnchor = e.currentTarget.value as typeof rootAnchor)}>
          <option value="center">center (pinned)</option>
          <option value="bottom">bottom (pinned)</option>
          <option value="none">none (free)</option>
        </select>
      </label>
      <div class="legend">
        {#each legend as l (l.label)}
          <span class="chip"><i style:background={l.color}></i>{l.label}</span>
        {/each}
      </div>
      <p class="note">Click a node to reveal its label + 1-hop neighbours · drag to reheat · scroll to zoom.</p>
    </section>
  </aside>

  <div class="graph-tab canvas-wrap">
    <GraphCanvas
      open={true}
      nodes={activeGraph.nodes}
      edges={activeGraph.edges}
      {visibleNodeIds}
      visibleEdges={visible.edges}
      {focalIds}
      {focalAnchor}
      {selectedId}
      onSelect={(id) => (selectedId = id)}
      {force}
    />
  </div>
</div>

<style>
  /* Theme tokens mirror App.svelte so the tuner renders the graph in the
     exact live palette. GraphCanvas reads these off :root via
     getComputedStyle and re-reads on the data-theme flip. */
  :global(:root[data-theme="dark"]) {
    --bg: #1c1c1e;
    --bg-card: #232325;
    --text: #ebebf0;
    --text-secondary: #8e8e93;
    --border: #3a3a3c;
    --btn-bg: #2a2a2c;
    --hover-bg: rgba(255, 255, 255, 0.06);
    --accent: #3fb950;
    --warn-text: #e3b341;
    --g-doc: #ff8a3d;
    --g-img: #b07dff;
    --g-tag: #6cd07a;
    --g-language: #ff4db8;
    --g-source: #4169e1;
    --g-binary: #5e5e62;
    --g-folder: #8e8e93;
    --g-contact: var(--warn-text);
    --fb-drafts-fg: #e3b341;
  }
  :global(:root[data-theme="light"]) {
    --bg: #ffffff;
    --bg-card: #f5f5f7;
    --text: #1c1c1e;
    --text-secondary: #6c6c70;
    --border: #d1d1d6;
    --btn-bg: #f2f2f4;
    --hover-bg: rgba(0, 0, 0, 0.05);
    --accent: #1a7f37;
    --warn-text: #9a6700;
    --g-doc: #c25a1f;
    --g-img: #7a4cd8;
    --g-tag: #2f9444;
    --g-language: #c71585;
    --g-source: #2851c4;
    --g-binary: #4e4e54;
    --g-folder: #6c6c70;
    --g-contact: var(--warn-text);
    --fb-drafts-fg: #9a6700;
  }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .tuner {
    display: flex;
    height: 100%;
    background: var(--bg);
    color: var(--text);
  }
  .panel {
    width: 320px;
    flex: 0 0 320px;
    height: 100%;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--bg-card);
    padding: 12px 14px 40px;
    box-sizing: border-box;
    font-size: 12px;
  }
  .panel-head h1 {
    margin: 4px 0 2px;
    font-size: 15px;
    font-weight: 700;
  }
  .sub {
    margin: 0 0 8px;
    color: var(--text-secondary);
    font-size: 11px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }
  section {
    border-top: 1px solid var(--border);
    padding: 10px 0;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .section-head h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 2px 8px;
    margin: 7px 0;
  }
  .row .name {
    grid-column: 1;
  }
  .row .val {
    grid-column: 2;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .row input[type="range"] {
    grid-column: 1 / -1;
    width: 100%;
    accent-color: var(--accent);
  }
  .row.inline {
    grid-template-columns: 1fr auto;
  }
  .row.inline input,
  .row.inline select,
  .row.inline button {
    grid-column: 2;
  }
  .num {
    width: 70px;
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 6px;
    box-sizing: border-box;
  }
  select {
    background: var(--btn-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 6px;
  }
  button {
    cursor: pointer;
    border-radius: 5px;
    border: 1px solid var(--border);
    padding: 3px 9px;
    font-size: 11px;
    background: var(--btn-bg);
    color: var(--text);
  }
  button:hover {
    background: var(--hover-bg);
  }
  button.primary {
    border-color: var(--accent);
    color: var(--accent);
  }
  button.ghost {
    background: transparent;
  }
  .literal {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
    overflow-x: auto;
  }
  .note {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.4;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin: 8px 0 2px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .chip i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    display: inline-block;
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    height: 100%;
    background: var(--bg);
  }
</style>
