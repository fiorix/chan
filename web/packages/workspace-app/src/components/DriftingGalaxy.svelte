<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createDriftingGalaxyRenderer,
    type DriftingGalaxyRenderer,
  } from "./driftingGalaxy";

  // The sketch takes 0.003 off its clock every frame at 60 frames a second;
  // this runs at half that.
  const CLOCK_PER_SECOND = -0.09;
  const STATIC_CLOCK = 0;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: DriftingGalaxyRenderer;
        try {
          renderer = createDriftingGalaxyRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Drifting Galaxy WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        function draw(clock: number): void {
          const fieldScale = canvasCssNumber(
            host,
            "--drifting-galaxy-field-scale",
            1.1,
          );
          const tone = canvasCssNumber(
            host,
            "--drifting-galaxy-tone",
            0.68,
          );
          const opacity = canvasCssNumber(
            host,
            "--drifting-galaxy-opacity",
            0.595,
          );
          renderer.draw(clock, fieldScale, tone, opacity);
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * CLOCK_PER_SECOND);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_CLOCK);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_CLOCK),
          destroy: renderer.destroy,
        };
      },
      // The grains are a pixel or two across, so they are drawn at the
      // display's density; the vertex work is the same at either.
      { maxDpr: 2 },
    );
  });
</script>

<div class="drifting-galaxy" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .drifting-galaxy {
    position: absolute;
    inset: 0;
    z-index: 0;
    --drifting-galaxy-field-scale: 1.1;
    --drifting-galaxy-tone: 0.68;
    --drifting-galaxy-opacity: 0.595;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .drifting-galaxy {
    --drifting-galaxy-tone: 0;
    --drifting-galaxy-opacity: 0.5;
  }
  :global([data-theme="dark"]) .drifting-galaxy {
    --drifting-galaxy-tone: 0.68;
    --drifting-galaxy-opacity: 0.595;
  }
  @media (prefers-reduced-motion: reduce) {
    .drifting-galaxy {
      opacity: 0.84;
    }
  }
</style>
