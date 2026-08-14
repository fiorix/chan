<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildExponentialThreadPoints,
    fitExponentialThread,
  } from "./exponentialThread";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = 0.018;
  const STATIC_PHASE = Math.PI / 2;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(phase: number): void {
        if (width <= 0 || height <= 0) return;

        const centerColor = canvasCssValue(
          host,
          "--exponential-thread-center-rgb",
          "112, 112, 112",
        );
        const edgeColor = canvasCssValue(
          host,
          "--exponential-thread-edge-rgb",
          "218, 218, 218",
        );
        const lineAlpha = canvasCssNumber(
          host,
          "--exponential-thread-line-alpha",
          0.075,
        );
        const points = buildExponentialThreadPoints(phase);
        const transform = fitExponentialThread(width, height);
        let outerRadius = 1;

        for (let index = 0; index < points.length; index += 2) {
          outerRadius = Math.max(
            outerRadius,
            Math.hypot(
              points[index] * transform.scaleX,
              points[index + 1] * transform.scaleY,
            ),
          );
        }
        const lineGradient = ctx.createRadialGradient(
          transform.centerX,
          transform.centerY,
          0,
          transform.centerX,
          transform.centerY,
          outerRadius,
        );
        lineGradient.addColorStop(0, `rgb(${centerColor})`);
        lineGradient.addColorStop(1, `rgb(${edgeColor})`);

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = lineGradient;
        ctx.globalAlpha = lineAlpha;
        ctx.lineWidth = Math.max(0.8, 3 * transform.scaleY);
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(
          transform.centerX + points[0] * transform.scaleX,
          transform.centerY + points[1] * transform.scaleY,
        );

        for (let index = 2; index < points.length; index += 2) {
          ctx.lineTo(
            transform.centerX + points[index] * transform.scaleX,
            transform.centerY + points[index + 1] * transform.scaleY,
          );
        }

        ctx.stroke();
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

<div class="exponential-thread" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .exponential-thread {
    position: absolute;
    inset: 0;
    z-index: 0;
    --exponential-thread-center-rgb: 112, 112, 112;
    --exponential-thread-edge-rgb: 218, 218, 218;
    --exponential-thread-line-alpha: 0.075;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .exponential-thread {
    --exponential-thread-center-rgb: 0, 0, 0;
    --exponential-thread-edge-rgb: 120, 120, 120;
    --exponential-thread-line-alpha: 0.11;
  }
  :global([data-theme="dark"]) .exponential-thread {
    --exponential-thread-center-rgb: 112, 112, 112;
    --exponential-thread-edge-rgb: 218, 218, 218;
    --exponential-thread-line-alpha: 0.075;
  }
  @media (prefers-reduced-motion: reduce) {
    .exponential-thread {
      opacity: 0.82;
    }
  }
</style>
