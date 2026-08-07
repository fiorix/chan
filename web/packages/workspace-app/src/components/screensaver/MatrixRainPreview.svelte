<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    createRainColumns,
    DRAW_INTERVAL_MS,
    drawStaticMatrix,
    gridDimensions,
    stepRain,
    type RainColumn,
  } from "./matrixRain";

  // Matrix preview for the dashboard About-slot config. Renders the SAME
  // falling rain as the fullscreen screensaver (MatrixRain.svelte) via the
  // shared engine, scaled into a fixed preview box, so the preview matches
  // the screensaver's look: sparse falling columns over black, not a wall
  // of glyphs.
  //
  // The dashboard back face is latched-mounted and rotated away when the card
  // shows its front, so the animation self-gates to avoid wasted work: it runs
  // only while the canvas is on-screen (IntersectionObserver) and the document
  // is visible, and falls back to a single accurate still under
  // prefers-reduced-motion. (The rotated-away-but-mounted case is invisible to
  // IntersectionObserver; that tiny interval is still cleared on destroy.)

  let {
    width = 320,
    height = 180,
    animated = true,
  }: { width?: number; height?: number; animated?: boolean } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();
  let ctx: CanvasRenderingContext2D | null = null;
  let fontsReady = false;
  let columns: RainColumn[] = [];
  let grid = { numCols: 0, numChars: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let onScreen = true;
  let observer: IntersectionObserver | null = null;
  const reduced =
    typeof window === "undefined"
      ? null
      : window.matchMedia("(prefers-reduced-motion: reduce)");

  // Device pixel ratio matters here: the box is small, so glyph blur on retina
  // is visible. We scale the backing store and map drawing units back to CSS
  // pixels so the shared grid math stays in CSS-pixel space.
  function dpr(): number {
    return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  }

  // Size the backing store, set the CSS-pixel transform, and (re)derive the
  // grid + a fresh column set. Callers clear the canvas separately when they
  // want the rain to fall in from the top again.
  function resetCanvas(): void {
    if (!canvas || !ctx) return;
    const ratio = dpr();
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    grid = gridDimensions(width, height);
    columns = createRainColumns(grid.numCols, grid.numChars);
  }

  function stopLoop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Start/stop the incremental rain loop to match the current gates. Reduced
  // motion paints one still and never loops; otherwise the loop runs only while
  // visible. The interval reads `columns`/`grid` live, so a resize that swaps
  // them in does not need a restart.
  function sync(): void {
    if (!ctx || !fontsReady) return;
    if (reduced?.matches) {
      stopLoop();
      drawStaticMatrix(ctx, grid.numCols, grid.numChars);
      return;
    }
    const run =
      animated &&
      onScreen &&
      !(typeof document !== "undefined" && document.hidden);
    if (run) {
      if (timer === null) {
        timer = setInterval(() => {
          if (ctx) stepRain(ctx, columns, grid.numCols, grid.numChars);
        }, DRAW_INTERVAL_MS);
      }
    } else {
      stopLoop();
    }
  }

  function onVisibilityChange(): void {
    sync();
  }

  async function loadMatrixFont(): Promise<void> {
    if (typeof document === "undefined" || !document.fonts) return;
    try {
      await document.fonts.load("20px matrix_code");
    } catch {
      // A missing font falls back to the canvas default; still legible.
    }
  }

  onMount(() => {
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    if (!ctx) return;
    resetCanvas();

    observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 },
    );
    observer.observe(canvas);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    reduced?.addEventListener?.("change", onVisibilityChange);

    void loadMatrixFont().then(() => {
      fontsReady = true;
      if (!ctx) return;
      // Clear + fresh columns so the rain falls in from the top once the matrix
      // face has resolved (no fallback-font flash), then start if visible.
      resetCanvas();
      sync();
    });
  });

  onDestroy(() => {
    stopLoop();
    observer?.disconnect();
    observer = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    reduced?.removeEventListener?.("change", onVisibilityChange);
  });

  // React to size / animated prop changes after mount: re-size, re-seed, and
  // re-evaluate the loop. Guarded on fontsReady so it doesn't fight the initial
  // font-load path above.
  $effect(() => {
    void width;
    void height;
    void animated;
    if (!ctx || !fontsReady) return;
    resetCanvas();
    sync();
  });
</script>

<canvas
  bind:this={canvas}
  class="matrix-rain-preview"
  style="width: {width}px; height: {height}px;"
  aria-hidden="true"
></canvas>

<style>
  @font-face {
    font-family: "matrix_code";
    src: url("/static/matrix/matrix_code.woff2") format("woff2");
    font-weight: normal;
    font-style: normal;
  }

  .matrix-rain-preview {
    display: block;
    background: #000;
    border-radius: 6px;
  }
</style>
