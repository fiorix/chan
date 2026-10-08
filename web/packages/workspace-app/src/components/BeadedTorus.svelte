<script lang="ts">
  import { onMount } from "svelte";
  import {
    BEADED_TORUS_BEAD_COUNT,
    BEADED_TORUS_SOURCE_SIZE,
    buildBeadedTorusBeads,
  } from "./beadedTorus";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createRoundPointRenderer,
    ROUND_POINT_FLOATS,
    type RoundPointRenderer,
  } from "./roundPoints";

  // The sketch advances 0.02 of a bead spacing per frame at 60 frames a
  // second; this runs at half that.
  const PHASE_PER_SECOND = 0.6;
  const STATIC_PHASE = 0;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: RoundPointRenderer;
        try {
          renderer = createRoundPointRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Beaded Torus WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        const beads = new Float32Array(
          BEADED_TORUS_BEAD_COUNT * ROUND_POINT_FLOATS,
        );

        function draw(phase: number): void {
          renderer.draw({
            points: buildBeadedTorusBeads(phase, beads),
            pointCount: BEADED_TORUS_BEAD_COUNT,
            sourceSize: BEADED_TORUS_SOURCE_SIZE,
            fieldScale: canvasCssNumber(
              host,
              "--beaded-torus-field-scale",
              1,
            ),
            tone: canvasCssNumber(host, "--beaded-torus-tone", 0.855),
            opacity: canvasCssNumber(
              host,
              "--beaded-torus-opacity",
              0.5,
            ),
          });
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * PHASE_PER_SECOND);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_PHASE);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_PHASE),
          destroy: renderer.destroy,
        };
      },
      // The beads are a few pixels across, so they are drawn at the
      // display's density; 3,200 points cost the same at either.
      { maxDpr: 2 },
    );
  });
</script>

<div class="beaded-torus" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .beaded-torus {
    position: absolute;
    inset: 0;
    z-index: 0;
    --beaded-torus-field-scale: 1;
    --beaded-torus-tone: 0.855;
    --beaded-torus-opacity: 0.5;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .beaded-torus {
    --beaded-torus-tone: 0;
    --beaded-torus-opacity: 0.4;
  }
  :global([data-theme="dark"]) .beaded-torus {
    --beaded-torus-tone: 0.855;
    --beaded-torus-opacity: 0.5;
  }
  @media (prefers-reduced-motion: reduce) {
    .beaded-torus {
      opacity: 0.84;
    }
  }
</style>
