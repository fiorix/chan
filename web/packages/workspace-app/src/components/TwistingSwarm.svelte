<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createRoundPointRenderer,
    ROUND_POINT_FLOATS,
    type RoundPointRenderer,
  } from "./roundPoints";
  import {
    buildTwistingSwarmDots,
    TWISTING_SWARM_DOT_COUNT,
    TWISTING_SWARM_PHASE_PER_FRAME,
    TWISTING_SWARM_SOURCE_SIZE,
  } from "./twistingSwarm";

  // The sketch runs at 60 frames a second; this runs at an eighth of that.
  const SOURCE_FRAMES_PER_SECOND = 7.5;
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
            "[chan] Twisting Swarm WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        const dots = new Float32Array(
          TWISTING_SWARM_DOT_COUNT * ROUND_POINT_FLOATS,
        );

        function draw(phase: number): void {
          renderer.draw({
            points: buildTwistingSwarmDots(phase, dots),
            pointCount: TWISTING_SWARM_DOT_COUNT,
            sourceSize: TWISTING_SWARM_SOURCE_SIZE,
            fieldScale: canvasCssNumber(
              host,
              "--twisting-swarm-field-scale",
              1,
            ),
            tone: canvasCssNumber(host, "--twisting-swarm-tone", 0.635),
            opacity: canvasCssNumber(
              host,
              "--twisting-swarm-opacity",
              0.465,
            ),
          });
        }

        function drawAt(timeMs: number): void {
          draw(
            timeMs *
              0.001 *
              SOURCE_FRAMES_PER_SECOND *
              TWISTING_SWARM_PHASE_PER_FRAME,
          );
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
      // The dots are a few pixels across, so they are drawn at the
      // display's density; a few thousand points cost the same at either.
      { maxDpr: 2 },
    );
  });
</script>

<div class="twisting-swarm" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .twisting-swarm {
    position: absolute;
    inset: 0;
    z-index: 0;
    --twisting-swarm-field-scale: 1;
    --twisting-swarm-tone: 0.635;
    --twisting-swarm-opacity: 0.465;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .twisting-swarm {
    --twisting-swarm-tone: 0;
    --twisting-swarm-opacity: 0.55;
  }
  :global([data-theme="dark"]) .twisting-swarm {
    --twisting-swarm-tone: 0.635;
    --twisting-swarm-opacity: 0.465;
  }
  @media (prefers-reduced-motion: reduce) {
    .twisting-swarm {
      opacity: 0.84;
    }
  }
</style>
