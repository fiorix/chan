<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildOrbitalCircles,
    ORBITAL_RING_COUNT,
  } from "./orbitalRosette";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = -0.3;
  const STATIC_PHASE = -0.8;
  const REFERENCE_SIZE = 800;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(phase: number): void {
        if (width <= 0 || height <= 0) return;

        const strokeColor = canvasCssValue(
          host,
          "--orbital-rosette-stroke-rgb",
          "200, 200, 200",
        );
        const alphaBase = canvasCssNumber(
          host,
          "--orbital-rosette-alpha-base",
          0.055,
        );
        const alphaRange = canvasCssNumber(
          host,
          "--orbital-rosette-alpha-range",
          0.14,
        );
        const sizeScale = canvasCssNumber(
          host,
          "--orbital-rosette-size-scale",
          1.35,
        );
        const scale =
          (Math.min(width, height) / REFERENCE_SIZE) * sizeScale;
        const circles = buildOrbitalCircles(phase, scale);

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = `rgb(${strokeColor})`;
        ctx.lineWidth = Math.max(0.75, Math.min(1.4, scale));

        for (const circle of circles) {
          ctx.globalAlpha =
            alphaBase +
            (circle.ring / ORBITAL_RING_COUNT) * alphaRange;
          ctx.beginPath();
          ctx.arc(
            width / 2 + circle.x,
            height / 2 + circle.y,
            circle.radius,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
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

<div class="orbital-rosette" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .orbital-rosette {
    position: absolute;
    inset: 0;
    z-index: 0;
    --orbital-rosette-stroke-rgb: 200, 200, 200;
    --orbital-rosette-alpha-base: 0.055;
    --orbital-rosette-alpha-range: 0.14;
    --orbital-rosette-size-scale: 1.35;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .orbital-rosette {
    --orbital-rosette-stroke-rgb: 0, 0, 0;
    --orbital-rosette-alpha-base: 0.085;
    --orbital-rosette-alpha-range: 0.2;
  }
  :global([data-theme="dark"]) .orbital-rosette {
    --orbital-rosette-stroke-rgb: 218, 218, 218;
    --orbital-rosette-alpha-base: 0.065;
    --orbital-rosette-alpha-range: 0.16;
  }
  @media (prefers-reduced-motion: reduce) {
    .orbital-rosette {
      opacity: 0.82;
    }
  }
</style>
