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
  //
  // What is drawn follows the Graph tab's rules (../graph/selectionView.ts):
  // the workspace's tree as far as it is opened, with what the selected node
  // reveals laid over it. Click a node to select it; the depth is that
  // node's. Double-click a directory to open or close it. The Pins and
  // Framing choices override the graph's own answer, to try another layout.

  import GraphCanvas from "../components/GraphCanvas.svelte";
  import { directoryNodeId } from "../graph/canvasNodes";
  import { DEFAULT_FORCE, type GraphForce } from "../graph/force";
  import {
    graphNodeIds, openBelow, openedDepth, openedFor, selectedDirectory, selectionDepthCap,
    type Opened,
  } from "../graph/selectionView";
  import {
    defaultSpec, makeTunerGraph, tunerSubjects,
    type GraphSpec, type TunerEdge, type TunerGraph,
  } from "./fakeData";
  // ---- tunable state ----------------------------------------------------
  //
  // Every control starts from the page's query string and is written back
  // to it, so a link reproduces the layout it was copied from.

  const query = new URLSearchParams(window.location.search);
  function queryChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = query.get(name);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  }
  function queryNumber(name: string, fallback: number): number {
    const value = query.get(name);
    const parsed = value === null || value === "" ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const FORCE_KEYS = Object.keys(DEFAULT_FORCE) as (keyof GraphForce)[];
  const SPEC_KEYS = Object.keys(defaultSpec) as (keyof GraphSpec)[];

  let force = $state<GraphForce>(
    Object.fromEntries(FORCE_KEYS.map((k) => [k, queryNumber(k, DEFAULT_FORCE[k])])) as GraphForce,
  );
  const querySpec = Object.fromEntries(
    SPEC_KEYS.map((k) => [k, queryNumber(k, defaultSpec[k])]),
  ) as GraphSpec;
  let spec = $state<GraphSpec>(querySpec);

  /// Hops of references a selected file, tag, mention or contact reveals.
  /// It goes back to 1 on every new selection.
  let hops = $state(queryNumber("hops", 1));
  /// Which nodes the canvas pins: the graph's own answer (the workspace's
  /// node), the selected node, or none.
  const PINS = ["root", "selected", "none"] as const;
  let pins = $state<(typeof PINS)[number]>(queryChoice("pins", PINS, "root"));
  /// How the canvas frames the layout: the graph's own answer (bottom), or
  /// one of the canvas's other framings.
  const FRAMINGS = ["bottom", "center", "bounds"] as const;
  let framing = $state<(typeof FRAMINGS)[number]>(queryChoice("framing", FRAMINGS, "bottom"));
  let uiTheme = $state<"dark" | "light">(queryChoice("theme", ["dark", "light"] as const, "dark"));
  /// The selected node. The graph starts on the node the query names, the
  /// workspace's own when it names none, as a graph tab opens.
  const NOTHING = "(nothing)";
  const querySelect = query.get("select") ?? "";
  let selectedId = $state<string | null>(querySelect === NOTHING ? null : querySelect);
  let copied = $state(false);

  const activeGraph: TunerGraph = $derived(makeTunerGraph(spec));
  /// What the Selected menu offers, by kind, in the active dataset.
  const subjectChoices = $derived(tunerSubjects(spec));

  /// The tree's state: the directories that are opened. The query lists
  /// them; with none listed the graph opens as one does on the node it
  /// starts on.
  const queryOpen = query.get("open");
  let opened = $state<Opened>(
    queryOpen === null
      ? openedFor(makeTunerGraph(querySpec).nodes, querySelect === NOTHING ? null : querySelect)
      : Object.fromEntries(["", ...queryOpen.split(",").filter(Boolean)].map((dir) => [dir, true])),
  );

  // ---- the depth, which is the selected node's ---------------------------

  /// The directory the depth acts on: the selected one, the root when
  /// nothing is selected, null when the selection is not a directory.
  const depthDir: string | null = $derived(selectedDirectory(activeGraph.nodes, selectedId));
  const depthMax: number = $derived(
    selectionDepthCap(activeGraph.nodes, activeGraph.edges, selectedId),
  );
  /// A directory's depth is read from the tree; any other node's is the
  /// hops its selection reveals.
  const depth: number = $derived(
    depthDir !== null
      ? Math.min(openedDepth(activeGraph.nodes, opened, depthDir), depthMax)
      : Math.max(1, Math.min(hops, depthMax)),
  );
  /// A directory other than the root can be closed, which is depth 0.
  const depthMin: number = $derived(depthDir !== null && depthDir !== "" ? 0 : 1);
  function setDepth(value: number): void {
    if (depthDir !== null) opened = openBelow(activeGraph.nodes, opened, depthDir, value);
    else hops = value;
  }

  /// Selecting a node makes the depth that node's: a directory's is read
  /// from the tree as it stands, any other node starts at one hop.
  function select(id: string | null): void {
    selectedId = id;
    hops = 1;
  }
  /// Double-click: open a closed directory, close an opened one.
  function toggleSelectedDirectory(): void {
    if (depthDir === null || depthDir === "") return;
    const isOpen = openedDepth(activeGraph.nodes, opened, depthDir) > 0;
    opened = openBelow(activeGraph.nodes, opened, depthDir, isOpen ? 0 : 1);
  }

  // What the canvas is handed, derived as GraphPanel derives it with every
  // filter chip on: the graph's nodes, the edges between them, and a meta
  // node only where one of those edges reaches it.
  const visible: { ids: Set<string>; edges: TunerEdge[] } = $derived.by(() => {
    const included = graphNodeIds({
      nodes: activeGraph.nodes,
      edges: activeGraph.edges,
      opened,
      selectedId,
      depth,
    });
    const edges = activeGraph.edges.filter((e) => included.has(e.source) && included.has(e.target));
    const ids = new Set<string>();
    for (const n of activeGraph.nodes) {
      if (included.has(n.id) && (n.kind === "file" || n.kind === "folder")) ids.add(n.id);
    }
    for (const e of edges) {
      ids.add(e.source);
      ids.add(e.target);
    }
    return { ids, edges };
  });
  const visibleNodeIds: Set<string> = $derived(visible.ids);

  const focalIds: string[] = $derived(
    pins === "root" ? [""] : pins === "selected" && selectedId !== null ? [selectedId] : [],
  );

  // The query string follows the controls. A value at its default is left
  // out, so a link names only what was changed.
  $effect(() => {
    const next = new URLSearchParams();
    if (selectedId !== "") next.set("select", selectedId ?? NOTHING);
    const dirs = Object.keys(opened).filter((dir) => dir !== "" && opened[dir]).sort();
    if (dirs.length > 0) next.set("open", dirs.join(","));
    if (hops !== 1) next.set("hops", String(hops));
    if (pins !== "root") next.set("pins", pins);
    if (framing !== "bottom") next.set("framing", framing);
    if (uiTheme !== "dark") next.set("theme", uiTheme);
    for (const k of FORCE_KEYS) {
      if (force[k] !== DEFAULT_FORCE[k]) next.set(k, String(force[k]));
    }
    for (const k of SPEC_KEYS) {
      if (spec[k] !== defaultSpec[k]) next.set(k, String(spec[k]));
    }
    const search = next.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  });

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
    { key: "linkDistanceTag", label: "Link distance · light edges", min: 10, max: 220, step: 1, hint: "tag / mention / contains / language edges" },
    { key: "linkStrength", label: "Link strength", min: 0, max: 2, step: 0.01, hint: "spring stiffness on every edge" },
    { key: "collidePad", label: "Collide padding", min: 0, max: 24, step: 0.5, hint: "extra gap added to each node radius" },
    { key: "velocityDecay", label: "Velocity decay", min: 0.05, max: 0.95, step: 0.01, hint: "friction; higher settles faster" },
    { key: "centerStrength", label: "Center strength", min: 0, max: 0.5, step: 0.005, hint: "pull toward x=0 (holds floaters in)" },
    { key: "hierarchyYSpacing", label: "Hierarchy Y spacing", min: 0, max: 300, step: 5, hint: "vertical gap between filesystem depth bands" },
    { key: "hierarchyYStrength", label: "Hierarchy Y strength", min: 0, max: 1, step: 0.01, hint: "how hard nodes snap to their depth band" },
    { key: "parentXStrength", label: "Parent X strength", min: 0, max: 1, step: 0.01, hint: "pull toward parent dir's X (clusters siblings)" },
    { key: "metaLift", label: "Meta lift", min: 0, max: 3, step: 0.25, hint: "bands a tag / mention / language sits above its deepest file; 0 leaves it floating at the root's level" },
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
    { color: "var(--g-symlink)", label: "symlink edge" },
    { color: "var(--g-hardlink)", label: "hardlink edge" },
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
      <div class="section-head"><h2>Graph</h2></div>
      <label class="row inline" title="The selected node; the same as clicking it on the canvas">
        <span class="name">Selected</span>
        <select value={selectedId ?? NOTHING} onchange={(e) => select(e.currentTarget.value === NOTHING ? null : e.currentTarget.value)}>
          <option value={NOTHING}>{NOTHING}</option>
          <option value="">workspace</option>
          <optgroup label="directories">
            {#each subjectChoices.dir as path (path)}
              <option value={directoryNodeId(path)}>{path}/</option>
            {/each}
          </optgroup>
          <optgroup label="files">
            {#each subjectChoices.file as path (path)}
              <option value={path}>{path}</option>
            {/each}
          </optgroup>
          <optgroup label="contacts">
            {#each subjectChoices.contact as path (path)}
              <option value={path}>{path}</option>
            {/each}
          </optgroup>
          <optgroup label="tags">
            {#each subjectChoices.tag as id (id)}
              <option value={id}>{id}</option>
            {/each}
          </optgroup>
          <optgroup label="mentions">
            {#each subjectChoices.mention as id (id)}
              <option value={id}>{id}</option>
            {/each}
          </optgroup>
          <optgroup label="languages">
            {#each subjectChoices.language as name (name)}
              <option value={`language:${name}`}>{name}</option>
            {/each}
          </optgroup>
        </select>
      </label>
      <label
        class="row"
        title={depthDir !== null
          ? "Directory levels opened below the selected directory (the root when nothing is selected)"
          : "Hops of references walked from the selected node"}
      >
        <span class="name">Depth · {depthDir !== null ? "levels" : "hops"}</span>
        <span class="val">{depth} / {depthMax}</span>
        <input
          type="range"
          min={depthMin}
          max={depthMax}
          step="1"
          value={depth}
          disabled={depthMax <= depthMin}
          oninput={(e) => setDepth(+e.currentTarget.value)}
        />
      </label>
      <label class="row inline" title="Which nodes the canvas pins in place">
        <span class="name">Pins</span>
        <select value={pins} onchange={(e) => (pins = e.currentTarget.value as typeof pins)}>
          <option value="root">workspace root</option>
          <option value="selected">selected node</option>
          <option value="none">none</option>
        </select>
      </label>
      <label class="row inline" title="Where the automatic fit places the view">
        <span class="name">Framing</span>
        <select value={framing} onchange={(e) => (framing = e.currentTarget.value as typeof framing)}>
          <option value="bottom">bottom</option>
          <option value="center">center</option>
          <option value="bounds">bounds</option>
        </select>
      </label>
      <p class="note">Click a node to select it: the depth becomes that node's. Double-click a directory to open or close it.</p>
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
      <label class="row inline" title="Every file at the workspace root, no directories">
        <span class="name">Flat workspace</span>
        <input
          type="checkbox"
          checked={spec.flat === 1}
          onchange={(e) => updateSpec("flat", e.currentTarget.checked ? 1 : 0)}
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

    <section>
      <div class="section-head"><h2>View</h2></div>
      <label class="row inline">
        <span class="name">Theme</span>
        <button class="ghost" onclick={() => (uiTheme = uiTheme === "dark" ? "light" : "dark")}>
          {uiTheme}
        </button>
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
      focalAnchor={framing}
      {selectedId}
      onSelect={select}
      onSetAsScope={toggleSelectedDirectory}
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
    --g-symlink: #3cc8d8;
    --g-hardlink: #b4cc3a;
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
    --g-symlink: #0b7f8f;
    --g-hardlink: #6b8a14;
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
