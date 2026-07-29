<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildConcentricPulseRings,
    CONCENTRIC_PULSE_REFERENCE_SIZE,
  } from "./concentricPulse";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = 0.1885;
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

        const lineColor = canvasCssValue(
          host,
          "--concentric-pulse-line-rgb",
          "218, 218, 218",
        );
        const alphaBase = canvasCssNumber(
          host,
          "--concentric-pulse-alpha-base",
          0.096,
        );
        const alphaRange = canvasCssNumber(
          host,
          "--concentric-pulse-alpha-range",
          0.084,
        );
        const scale =
          Math.min(width, height) / CONCENTRIC_PULSE_REFERENCE_SIZE;
        const maxRadius =
          Math.hypot(width, height) / (2 * scale) +
          100;
        const rings = buildConcentricPulseRings(phase, maxRadius);

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.scale(scale, scale);
        ctx.strokeStyle = `rgb(${lineColor})`;
        ctx.globalAlpha =
          alphaBase +
          alphaRange * (0.5 + 0.5 * Math.cos(phase));
        ctx.lineWidth = Math.max(0.75, 1 / scale);
        ctx.lineJoin = "round";

        for (const ring of rings) {
          if (ring.vertices.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(ring.vertices[0].x, ring.vertices[0].y);
          for (let index = 1; index < ring.vertices.length; index += 1) {
            ctx.lineTo(ring.vertices[index].x, ring.vertices[index].y);
          }
          ctx.closePath();
          ctx.stroke();
        }

        ctx.restore();
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

<div class="concentric-pulse" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .concentric-pulse {
    position: absolute;
    inset: 0;
    z-index: 0;
    --concentric-pulse-line-rgb: 218, 218, 218;
    --concentric-pulse-alpha-base: 0.096;
    --concentric-pulse-alpha-range: 0.084;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .concentric-pulse {
    --concentric-pulse-line-rgb: 0, 0, 0;
    --concentric-pulse-alpha-base: 0.066;
    --concentric-pulse-alpha-range: 0.072;
  }
  :global([data-theme="dark"]) .concentric-pulse {
    --concentric-pulse-line-rgb: 218, 218, 218;
    --concentric-pulse-alpha-base: 0.096;
    --concentric-pulse-alpha-range: 0.084;
  }
  @media (prefers-reduced-motion: reduce) {
    .concentric-pulse {
      opacity: 0.82;
    }
  }
</style>
