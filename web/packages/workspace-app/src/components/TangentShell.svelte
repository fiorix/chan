<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createRoundPointRenderer, ROUND_POINT_FLOATS, type RoundPointRenderer } from "./roundPoints";
  import { buildTangentShell, TANGENT_SHELL_GRAIN_COUNT, TANGENT_SHELL_SOURCE_SIZE } from "./tangentShell";

  // Advance at one-third of the sketch's 60 Hz source tempo.
  const CLOCK_PER_SECOND = Math.PI * 20 / 256;
  const STATIC_CLOCK = 0.7;
  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: RoundPointRenderer;
      try {
        renderer = createRoundPointRenderer(gl);
      } catch (error) {
        console.warn("[chan] Tangent Shell WebGL renderer unavailable:", error);
        return null;
      }
      const points = new Float32Array(TANGENT_SHELL_GRAIN_COUNT * ROUND_POINT_FLOATS);

      function draw(clock: number): void {
        const pointCount = buildTangentShell(clock, points, canvasCssNumber(host, "--tangent-shell-max-radius", 6));
        renderer.draw({
          points,
          pointCount,
          sourceSize: TANGENT_SHELL_SOURCE_SIZE,
          fieldScale: canvasCssNumber(host, "--tangent-shell-field-scale", 0.95),
          tone: canvasCssNumber(host, "--tangent-shell-tone", 0.495),
          opacity: canvasCssNumber(host, "--tangent-shell-opacity", 0.68),
        });
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
    }, { maxDpr: 2 });
  });
</script>

<div class="tangent-shell" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .tangent-shell {
    position: absolute;
    inset: 0;
    z-index: 0;
    --tangent-shell-field-scale: 0.95;
    --tangent-shell-tone: 0.495;
    --tangent-shell-opacity: 0.68;
    --tangent-shell-max-radius: 6;
    pointer-events: none;
    overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .tangent-shell {
    --tangent-shell-tone: 0;
    --tangent-shell-opacity: 0.3;
  }
  :global([data-theme="dark"]) .tangent-shell {
    --tangent-shell-tone: 0.495;
    --tangent-shell-opacity: 0.68;
  }
</style>
