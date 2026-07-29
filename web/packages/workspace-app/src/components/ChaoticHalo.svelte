<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildChaoticHaloPoints,
    CHAOTIC_HALO_REFERENCE_SIZE,
    createChaoticHaloState,
    fitChaoticHalo,
  } from "./chaoticHalo";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const SOURCE_PHASE_PER_SECOND = 0.003;
  const STATIC_PHASE = 0.08;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let phase = 0;
      let lastSimulationMs = 0;
      let state = createChaoticHaloState();

      function draw(nextPhase: number): void {
        if (width <= 0 || height <= 0) return;

        const pointColor = canvasCssValue(
          host,
          "--chaotic-halo-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--chaotic-halo-point-alpha",
          0.105,
        );
        const transform = fitChaoticHalo(width, height);
        const points = buildChaoticHaloPoints(nextPhase, state);
        const pointSize = Math.max(
          0.65,
          (Math.min(width, height) /
            CHAOTIC_HALO_REFERENCE_SIZE) *
            0.72,
        );

        ctx.clearRect(0, 0, width, height);
        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;
        for (let index = 0; index < points.length; index += 2) {
          const x =
            transform.centerX +
            (points[index] -
              CHAOTIC_HALO_REFERENCE_SIZE / 2) *
              transform.scale;
          const y =
            transform.centerY +
            (points[index + 1] -
              CHAOTIC_HALO_REFERENCE_SIZE / 2) *
              transform.scale;
          ctx.fillRect(x, y, pointSize, pointSize);
        }
        ctx.globalAlpha = 1;
      }

      function drawStatic(): void {
        state = createChaoticHaloState();
        draw(STATIC_PHASE);
      }

      function drawAt(timeMs: number): void {
        const elapsedMs =
          lastSimulationMs === 0
            ? 1000 / 60
            : Math.min(1000 / 15, timeMs - lastSimulationMs);
        lastSimulationMs = timeMs;
        phase += (elapsedMs / 1000) * SOURCE_PHASE_PER_SECOND;
        draw(phase);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          phase = 0;
          lastSimulationMs = 0;
          state = createChaoticHaloState();
          if (reducedMotion) drawStatic();
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: drawStatic,
        start: () => {
          lastSimulationMs = 0;
        },
      };
    });
  });
</script>

<div class="chaotic-halo" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .chaotic-halo {
    position: absolute;
    inset: 0;
    z-index: 0;
    --chaotic-halo-point-rgb: 218, 218, 218;
    --chaotic-halo-point-alpha: 0.105;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .chaotic-halo {
    --chaotic-halo-point-rgb: 0, 0, 0;
    --chaotic-halo-point-alpha: 0.082;
  }
  :global([data-theme="dark"]) .chaotic-halo {
    --chaotic-halo-point-rgb: 218, 218, 218;
    --chaotic-halo-point-alpha: 0.105;
  }
  @media (prefers-reduced-motion: reduce) {
    .chaotic-halo {
      opacity: 0.82;
    }
  }
</style>
