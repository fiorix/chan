<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildThreefoldVeilPoints,
    fitThreefoldVeil,
    THREEFOLD_VEIL_REFERENCE_SIZE,
  } from "./threefoldVeil";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = Math.PI;
  const STATIC_PHASE = 0;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(phase: number): void {
        if (width <= 0 || height <= 0) return;

        const backgroundColor = canvasCssValue(
          host,
          "--threefold-veil-background-rgb",
          "28, 28, 30",
        );
        const pointColor = canvasCssValue(
          host,
          "--threefold-veil-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--threefold-veil-point-alpha",
          0.376,
        );
        const points = buildThreefoldVeilPoints(phase);
        const transform = fitThreefoldVeil(width, height);
        const sourceCenter = THREEFOLD_VEIL_REFERENCE_SIZE / 2;
        const pointSize = Math.max(
          0.75,
          Math.min(1.25, transform.scale),
        );

        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${backgroundColor})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;

        for (let index = 0; index < points.length; index += 2) {
          const x =
            transform.centerX +
            (points[index] - sourceCenter) * transform.scale;
          const y =
            transform.centerY +
            (points[index + 1] - sourceCenter) * transform.scale;
          ctx.fillRect(
            x - pointSize / 2,
            y - pointSize / 2,
            pointSize,
            pointSize,
          );
        }

        ctx.globalAlpha = 1;
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * 0.001 * PHASE_SPEED);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(STATIC_PHASE);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(STATIC_PHASE),
      };
    });
  });
</script>

<div class="threefold-veil" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .threefold-veil {
    position: absolute;
    inset: 0;
    z-index: 0;
    --threefold-veil-background-rgb: 28, 28, 30;
    --threefold-veil-point-rgb: 218, 218, 218;
    --threefold-veil-point-alpha: 0.376;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .threefold-veil {
    --threefold-veil-background-rgb: 255, 255, 255;
    --threefold-veil-point-rgb: 0, 0, 0;
    --threefold-veil-point-alpha: 0.4;
  }
  :global([data-theme="dark"]) .threefold-veil {
    --threefold-veil-background-rgb: 28, 28, 30;
    --threefold-veil-point-rgb: 218, 218, 218;
    --threefold-veil-point-alpha: 0.376;
  }
  @media (prefers-reduced-motion: reduce) {
    .threefold-veil {
      opacity: 0.82;
    }
  }
</style>
