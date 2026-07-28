<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildQuadraticBloomPoints,
    fitQuadraticBloom,
  } from "./quadraticBloom";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = (Math.PI * 60) / 1000;
  const STATIC_PHASE = 1.8;
  const REFERENCE_SIZE = 800;
  const DRAW_STRIDE = 2;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let needsClear = true;

      function draw(phase: number, reducedMotion = false): void {
        if (width <= 0 || height <= 0) return;

        const pointColor = canvasCssValue(
          host,
          "--quadratic-bloom-point-rgb",
          "200, 200, 200",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--quadratic-bloom-point-alpha",
          0.075,
        );
        const trailFade = canvasCssNumber(
          host,
          "--quadratic-bloom-trail-fade",
          0.18,
        );
        const transform = fitQuadraticBloom(width, height);
        const pointSize = Math.max(
          0.7,
          (Math.min(width, height) / REFERENCE_SIZE) * 1.1,
        );
        const points = buildQuadraticBloomPoints(phase);

        if (needsClear || reducedMotion) {
          ctx.clearRect(0, 0, width, height);
          needsClear = false;
        } else {
          ctx.globalCompositeOperation = "destination-out";
          ctx.globalAlpha = trailFade;
          ctx.fillRect(0, 0, width, height);
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;

        for (let index = 0; index < points.length; index += 2 * DRAW_STRIDE) {
          ctx.fillRect(
            transform.centerX + points[index] * transform.scaleX,
            transform.centerY + points[index + 1] * transform.scaleY,
            pointSize,
            pointSize,
          );
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * 0.001 * PHASE_SPEED);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          needsClear = true;
          if (reducedMotion) draw(STATIC_PHASE, true);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(STATIC_PHASE, true),
      };
    });
  });
</script>

<div class="quadratic-bloom" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .quadratic-bloom {
    position: absolute;
    inset: 0;
    z-index: 0;
    --quadratic-bloom-point-rgb: 200, 200, 200;
    --quadratic-bloom-point-alpha: 0.075;
    --quadratic-bloom-trail-fade: 0.18;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .quadratic-bloom {
    --quadratic-bloom-point-rgb: 0, 0, 0;
    --quadratic-bloom-point-alpha: 0.065;
  }
  :global([data-theme="dark"]) .quadratic-bloom {
    --quadratic-bloom-point-rgb: 218, 218, 218;
    --quadratic-bloom-point-alpha: 0.08;
  }
  @media (prefers-reduced-motion: reduce) {
    .quadratic-bloom {
      opacity: 0.82;
    }
  }
</style>
