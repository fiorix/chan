<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createRoundPointRenderer, ROUND_POINT_FLOATS, type RoundPointRenderer } from "./roundPoints";
  import { buildTurningShell, TURNING_SHELL_GRAIN_COUNT, TURNING_SHELL_SOURCE_SIZE } from "./turningShell";

  // Advance at two-thirds of the sketch's 60 Hz source tempo.
  const CLOCK_PER_SECOND = Math.PI * 40 / 2048;
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
        console.warn("[chan] Turning Shell WebGL renderer unavailable:", error);
        return null;
      }
      const points = new Float32Array(TURNING_SHELL_GRAIN_COUNT * ROUND_POINT_FLOATS);

      function draw(clock: number): void {
        const pointCount = buildTurningShell(clock, points);
        renderer.draw({
          points,
          pointCount,
          sourceSize: TURNING_SHELL_SOURCE_SIZE,
          fieldScale: canvasCssNumber(host, "--turning-shell-field-scale", 0.65),
          tone: canvasCssNumber(host, "--turning-shell-tone", 0.61),
          opacity: canvasCssNumber(host, "--turning-shell-opacity", 0.465),
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

<div class="turning-shell" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .turning-shell {
    position: absolute;
    inset: 0;
    z-index: 0;
    --turning-shell-field-scale: 0.65;
    --turning-shell-tone: 0.61;
    --turning-shell-opacity: 0.465;
    pointer-events: none;
    overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .turning-shell {
    --turning-shell-tone: 0;
    --turning-shell-opacity: 0.3;
  }
  :global([data-theme="dark"]) .turning-shell {
    --turning-shell-tone: 0.61;
    --turning-shell-opacity: 0.465;
  }
</style>
