<script lang="ts">
  // Standalone animation tuner. Runs without the chan server: the product's
  // own empty-pane surface (components/EmptyPaneWelcome.svelte) in a sized
  // stage, with the CSS tokens the shown animation reads (./tunables.ts)
  // exposed as live sliders.
  //
  // Because this mounts the real surface, the keys, the name and mark
  // flashes and the speed ladder are the product's. An animation reads its
  // tokens from its canvas's parent on every frame, so a slider writes an
  // inline override on that element: dial a look, hit "Copy CSS", and paste
  // the lines into the theme block of the animation's component.
  //
  // The query string scripts a still: a=<animation id>, theme=dark|light,
  // size=<preset>.

  import { onDestroy, onMount, untrack } from "svelte";
  import { canvasCssNumber } from "../components/canvasAnimation";
  import EmptyPaneWelcome from "../components/EmptyPaneWelcome.svelte";
  import {
    EMPTY_PANE_ANIMATIONS,
    initialEmptyPaneAnimation,
    persistEmptyPaneAnimation,
    type EmptyPaneAnimationId,
  } from "../components/emptyPaneAnimations";
  import { ANIMATION_TUNABLES, type Tunable } from "./tunables";

  type Theme = "dark" | "light";

  // 900x560 is the stage the frame-rate harness measures on
  // (scripts/e2e/animation-fps/index.html).
  const SIZES = {
    "900x560": { width: 900, height: 560 },
    "1440x810": { width: 1440, height: 810 },
    "700x500": { width: 700, height: 500 },
    fill: null,
  } as const;
  type SizeId = keyof typeof SIZES;
  const SIZE_IDS = Object.keys(SIZES) as SizeId[];

  const query = new URLSearchParams(window.location.search);
  function queryChoice<T extends string>(
    name: string,
    choices: readonly T[],
  ): T | undefined {
    const value = query.get(name);
    return choices.find((choice) => choice === value);
  }

  let selected = $state<EmptyPaneAnimationId>(
    queryChoice(
      "a",
      EMPTY_PANE_ANIMATIONS.map(({ id }) => id),
    ) ?? initialEmptyPaneAnimation(),
  );
  let theme = $state<Theme>(queryChoice("theme", ["dark", "light"]) ?? "dark");
  let size = $state<SizeId>(queryChoice("size", SIZE_IDS) ?? "900x560");

  let stage = $state<HTMLDivElement | undefined>();
  let copied = $state(false);
  const box = $derived(SIZES[size]);

  const description = $derived(
    EMPTY_PANE_ANIMATIONS.find(({ id }) => id === selected)?.description ?? "",
  );
  const tunables: Tunable[] = $derived(ANIMATION_TUNABLES[selected] ?? []);

  // A step with the surface's own keys persists the selection; a choice
  // from the select does the same here, so a reload returns to the
  // animation being tuned.
  function choose(id: EmptyPaneAnimationId): void {
    selected = id;
    persistEmptyPaneAnimation(id);
  }

  // Theme the page the way the app does: data-theme on <html>. A pre-effect
  // because it has to land before the surface mounts: under reduced motion
  // an animation paints its one still frame as it mounts, from the tokens
  // the theme resolves at that moment.
  $effect.pre(() => {
    document.documentElement.setAttribute("data-theme", theme);
  });

  // ---- token sliders -----------------------------------------------------

  // Overrides are kept per theme, since a component's two theme blocks hold
  // different values, and outlive a switch to another animation and back.
  const overrides = new Map<string, number>();
  // The element the shown animation reads its tokens from.
  let host: HTMLElement | null = null;
  // What each token resolves to on that element, override or not.
  let values = $state<Record<string, number>>({});

  function shownHost(): HTMLElement | null {
    return stage?.querySelector("canvas")?.parentElement ?? null;
  }

  // Write the current theme's overrides on the shown animation's host and
  // read back what every token resolves to there. The component's own rule
  // sets each token on that element, so a value set on an ancestor loses.
  function applyTokens(): void {
    const shown = tunables;
    const scope = theme;
    const canvas = stage?.querySelector("canvas") ?? null;
    host = canvas?.parentElement ?? null;
    const next: Record<string, number> = {};
    if (canvas && host) {
      for (const { name } of shown) {
        const override = overrides.get(`${scope} ${name}`);
        if (override === undefined) host.style.removeProperty(name);
        else host.style.setProperty(name, String(override));
      }
      for (const { name } of shown) {
        next[name] = canvasCssNumber(canvas, name, Number.NaN);
      }
    }
    values = next;
  }

  // A theme flip changes what the component's rules resolve to, and a
  // switch mounts a new host with no overrides on it.
  $effect(() => {
    applyTokens();
  });

  // Under reduced motion an animation holds one still frame and draws again
  // only when it is resized, so a new token value would not show. The
  // runner redraws on the window's resize event.
  function repaintStill(): void {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      window.dispatchEvent(new Event("resize"));
    }
  }

  function setToken(name: string, value: number): void {
    overrides.set(`${theme} ${name}`, value);
    applyTokens();
    repaintStill();
  }

  function resetTokens(): void {
    for (const { name } of tunables) overrides.delete(`${theme} ${name}`);
    applyTokens();
    repaintStill();
  }

  function fmt(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return "unset";
    return String(Math.round(value * 1000) / 1000);
  }

  // The paste-ready lines for the component's theme block.
  const cssLiteral = $derived(
    tunables.map(({ name }) => `    ${name}: ${fmt(values[name])};`).join("\n"),
  );

  async function copyCss(): Promise<void> {
    try {
      await navigator.clipboard.writeText(cssLiteral);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  // ---- warnings ----------------------------------------------------------

  const MAX_WARNINGS = 20;
  let warnings = $state<string[]>([]);

  // An animation whose renderer cannot start says so through console.warn
  // with a "[chan]" prefix and then draws nothing; for a shader that fails
  // to compile the line carries the driver's log. Installed while this
  // script runs, since the surface below warns as it mounts.
  const consoleWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const text = args
      .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
      .join(" ");
    if (text.includes("[chan]")) {
      warnings = [...untrack(() => warnings).slice(1 - MAX_WARNINGS), text];
    }
    consoleWarn.apply(console, args);
  };
  onDestroy(() => {
    console.warn = consoleWarn;
  });

  // ---- readouts ----------------------------------------------------------

  const RATE_WINDOW_MS = 2000;
  const READOUT_INTERVAL_MS = 500;

  // The renderers scripts/e2e/animation-fps/main.ts refuses a reading on: a
  // software rasterizer, and an engine that will not say what it runs on.
  const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|lavapipe|software/i;
  const UNIDENTIFIABLE_RENDERERS = /^apple gpu$|^webkit webgl$|^apple inc/i;

  function gpuRenderer(): string | null {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    // Browsers cap the live WebGL contexts of a page; this probe gives its
    // own back rather than hold one against the animations.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" ? renderer : null;
  }

  const renderer = gpuRenderer();
  const rendererFlag =
    renderer === null
      ? "no WebGL2 context"
      : SOFTWARE_RENDERERS.test(renderer)
        ? "software rasterizer"
        : UNIDENTIFIABLE_RENDERERS.test(renderer.trim())
          ? "this engine hides its renderer"
          : null;

  let readout = $state({
    rate: "",
    p95: "",
    buffer: "",
    css: "",
    dpr: "",
  });

  onMount(() => {
    // A hot reload of an animation's module remounts it on a new element
    // without changing the selection, so the stage is watched for a host
    // the overrides were not written on.
    const observer = new MutationObserver(() => {
      if (shownHost() !== host) applyTokens();
    });
    if (stage) observer.observe(stage, { childList: true, subtree: true });

    // The page's own frame callbacks over the last two seconds. This reads
    // the health of the thread and the compositor; an animation caps its
    // own draw rate below it.
    const frames: number[] = [];
    let frameId = requestAnimationFrame(function onFrame(now: number) {
      frames.push(now);
      while (frames.length > 0 && frames[0]! < now - RATE_WINDOW_MS) {
        frames.shift();
      }
      frameId = requestAnimationFrame(onFrame);
    });

    function read(): void {
      const intervals = frames
        .slice(1)
        .map((time, index) => time - frames[index]!)
        .sort((a, b) => a - b);
      const span = frames.length > 1 ? frames.at(-1)! - frames[0]! : 0;
      const p95 =
        intervals[
          Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))
        ];
      const canvas = stage?.querySelector("canvas");
      readout = {
        rate:
          span > 0 ? `${((intervals.length / span) * 1000).toFixed(1)} fps` : "",
        p95: p95 === undefined ? "" : `${p95.toFixed(1)} ms`,
        buffer: canvas ? `${canvas.width} x ${canvas.height}` : "no canvas",
        css: canvas ? `${canvas.clientWidth} x ${canvas.clientHeight}` : "",
        dpr: String(window.devicePixelRatio),
      };
    }
    read();
    const timer = setInterval(read, READOUT_INTERVAL_MS);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      clearInterval(timer);
    };
  });
</script>

<div class="tuner">
  <aside class="panel">
    <header class="panel-head">
      <h1>animation tuner</h1>
      <p class="sub">live <code>EmptyPaneWelcome</code> · sliders write the tokens the shown animation reads</p>
    </header>

    <section>
      <div class="section-head"><h2>Animation</h2></div>
      <label class="row inline">
        <span class="name">Shown</span>
        <select
          name="animation"
          value={selected}
          onchange={(e) => choose(e.currentTarget.value as EmptyPaneAnimationId)}
        >
          {#each EMPTY_PANE_ANIMATIONS as animation (animation.id)}
            <option value={animation.id}>{animation.name}</option>
          {/each}
        </select>
      </label>
      <p class="note">{description}</p>
      <p class="note">Click the stage for the surface's own keys: ←/→ step, ? random, ↑/↓ speed.</p>
    </section>

    <section>
      <div class="section-head">
        <h2>Warnings</h2>
        {#if warnings.length > 0}
          <button class="ghost" onclick={() => (warnings = [])}>Clear</button>
        {/if}
      </div>
      {#each warnings as warning, index (index)}
        <pre class="literal warning">{warning}</pre>
      {:else}
        <p class="note">No <code>[chan]</code> warning. A shader that fails to compile shows here with the driver's log.</p>
      {/each}
    </section>

    <section>
      <div class="section-head">
        <h2>Tokens · {theme}</h2>
        {#if tunables.length > 0}
          <button class="ghost" onclick={resetTokens}>Reset</button>
        {/if}
      </div>
      {#each tunables as tunable (tunable.name)}
        <label class="row">
          <span class="name"><code>{tunable.name}</code></span>
          <span class="val">{fmt(values[tunable.name])}</span>
          <input
            type="range"
            name={tunable.name}
            min={tunable.min}
            max={tunable.max}
            step={tunable.step}
            value={values[tunable.name]}
            oninput={(e) => setToken(tunable.name, +e.currentTarget.value)}
          />
        </label>
      {:else}
        <p class="note">no tunables declared</p>
      {/each}
    </section>

    {#if tunables.length > 0}
      <section>
        <div class="section-head">
          <h2>Copy</h2>
          <button class="primary" onclick={copyCss}>{copied ? "Copied ✓" : "Copy CSS"}</button>
        </div>
        <pre class="literal">{cssLiteral}</pre>
        <p class="note">Paste into the <code>[data-theme="{theme}"]</code> block of the animation's component.</p>
      </section>
    {/if}

    <section>
      <div class="section-head"><h2>View</h2></div>
      <label class="row inline">
        <span class="name">Theme</span>
        <button class="ghost" name="theme" onclick={() => (theme = theme === "dark" ? "light" : "dark")}>
          {theme}
        </button>
      </label>
      <label class="row inline">
        <span class="name">Stage</span>
        <select name="size" value={size} onchange={(e) => (size = e.currentTarget.value as SizeId)}>
          {#each SIZE_IDS as id (id)}
            <option value={id}>{id === "fill" ? "fill viewport" : id}</option>
          {/each}
        </select>
      </label>
    </section>

    <section>
      <div class="section-head"><h2>Readouts</h2></div>
      <dl class="readouts">
        <dt>Page frames</dt>
        <dd>{readout.rate}</dd>
        <dt>p95 interval</dt>
        <dd>{readout.p95}</dd>
        <dt>Drawing buffer</dt>
        <dd>{readout.buffer}</dd>
        <dt>CSS size</dt>
        <dd>{readout.css}</dd>
        <dt>devicePixelRatio</dt>
        <dd>{readout.dpr}</dd>
        <dt>Renderer</dt>
        <dd>{renderer ?? ""}{#if rendererFlag}{" "}<span class="flag">{rendererFlag}</span>{/if}</dd>
      </dl>
      <p class="note">Page frames is the page's own frame callback rate over two seconds, not the animation's capped draw rate.</p>
    </section>
  </aside>

  <div class="stage-wrap">
    <div
      class="stage"
      class:fill={box === null}
      style:width={box ? `${box.width}px` : null}
      style:height={box ? `${box.height}px` : null}
      bind:this={stage}
    >
      <EmptyPaneWelcome bind:animation={selected} />
    </div>
  </div>
</div>

<style>
  /* The tokens the surface and this panel read, mirroring App.svelte so
     the stage renders in the live palette. */
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
  }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .tuner {
    display: flex;
    height: 100%;
    background: var(--bg-card);
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
  .row.inline select,
  .row.inline button {
    grid-column: 2;
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
  .literal.warning {
    margin-bottom: 6px;
    border-color: var(--warn-text);
    color: var(--warn-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 6px 0 0;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.4;
  }
  .readouts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  .readouts dt {
    color: var(--text-secondary);
  }
  .readouts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .flag {
    color: var(--warn-text);
  }
  /* Auto margins rather than centring, so a stage larger than the viewport
     scrolls from its own top left corner. */
  .stage-wrap {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: auto;
  }
  /* A row flex container, as the pane's placeholder is: the surface takes
     its size as a flex item of one. */
  .stage {
    display: flex;
    flex: none;
    margin: auto;
    background: var(--bg);
    overflow: hidden;
  }
  .stage.fill {
    width: 100%;
    height: 100%;
  }
</style>
