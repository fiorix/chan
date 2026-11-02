<script lang="ts">
  import { onMount } from "svelte";
  import DottedSurface from "../../workspace-app/src/components/DottedSurface.svelte";
  import { runWebgl2Animation } from "../../workspace-app/src/components/canvasAnimation";
  import { createRoundPointRenderer, ROUND_POINT_FLOATS, type RoundPointRenderer } from "../../workspace-app/src/components/roundPoints";
  import { pageWebglRenderer } from "../../workspace-app/src/components/webglRenderer";
  import { buildHomeAtmosphereFrame, HOME_POINT_COUNT, HOME_SOURCE_SIZE, sectionScrollProgress } from "./homeAtmosphere";

  let { morph = true }: { morph?: boolean } = $props();

  let canvas = $state<HTMLCanvasElement>();
  let fallback = $state(false);

  onMount(() => {
    if (!canvas) return;
    if (pageWebglRenderer().kind === "none") {
      fallback = true;
      return;
    }
    const section = document.querySelector("[data-home-morph-target]");
    let sectionTop = 0;
    let viewportHeight = window.innerHeight;
    let progress = morph ? 0 : 1;

    function scroll(): void {
      if (morph) progress = sectionScrollProgress(window.scrollY, sectionTop, viewportHeight);
    }
    function measure(): void {
      viewportHeight = window.innerHeight;
      sectionTop = section ? section.getBoundingClientRect().top + window.scrollY : viewportHeight;
      scroll();
    }
    measure();
    if (morph) window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", measure);

    const stop = runWebgl2Animation(canvas, (gl) => {
      let renderer: RoundPointRenderer;
      try {
        renderer = createRoundPointRenderer(gl);
      } catch {
        fallback = true;
        return null;
      }
      const points = new Float32Array(HOME_POINT_COUNT * ROUND_POINT_FLOATS);
      let width = 1;
      let height = 1;
      let reduced = false;
      function draw(timeMs: number): void {
        renderer.draw({
          points: buildHomeAtmosphereFrame(width, height, reduced ? 0 : timeMs, reduced ? 1 : progress, points),
          pointCount: HOME_POINT_COUNT,
          sourceSize: HOME_SOURCE_SIZE,
          fieldScale: 1,
          tone: 0.855,
          opacity: 0.32,
        });
      }
      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          reduced = reducedMotion;
          measure();
          draw(timeMs);
        },
        start() { reduced = false; },
        frame: draw,
        reducedMotion() { reduced = true; draw(0); },
        destroy: renderer.destroy,
      };
    }, { maxDpr: 1.5, maxPixels: 2_000_000 });

    return () => {
      stop();
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", measure);
    };
  });
</script>

<div class="home-atmosphere" aria-hidden="true">
  {#if fallback}
    <DottedSurface />
  {:else}
    <canvas bind:this={canvas}></canvas>
  {/if}
</div>

<style>
  .home-atmosphere { position: absolute; inset: 0; pointer-events: none; }
  canvas { display: block; width: 100%; height: 100%; }
  .home-atmosphere :global(.dotted-surface) { height: 50%; }
</style>
