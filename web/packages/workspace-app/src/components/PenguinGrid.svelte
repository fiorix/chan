<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildPenguinTiles,
    PENGUIN_GRID_SIZE,
  } from "./penguinGrid";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = 0.3;
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
          "--penguin-grid-line-rgb",
          "200, 200, 200",
        );
        const fillColor = canvasCssValue(
          host,
          "--penguin-grid-fill-rgb",
          "80, 90, 255",
        );
        const eyeColor = canvasCssValue(
          host,
          "--penguin-grid-eye-rgb",
          "218, 218, 218",
        );
        const lineAlpha = canvasCssNumber(
          host,
          "--penguin-grid-line-alpha",
          0.68,
        );
        const fillAlpha = canvasCssNumber(
          host,
          "--penguin-grid-fill-alpha",
          0.055,
        );
        const eyeAlpha = canvasCssNumber(
          host,
          "--penguin-grid-eye-alpha",
          0.16,
        );
        const tiles = buildPenguinTiles(phase);

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.scale(width / PENGUIN_GRID_SIZE, height / PENGUIN_GRID_SIZE);
        ctx.lineWidth = 1;

        for (const tile of tiles) {
          ctx.beginPath();
          ctx.moveTo(tile.start.x, tile.start.y);
          ctx.bezierCurveTo(
            tile.firstControl.x,
            tile.firstControl.y,
            tile.secondControl.x,
            tile.secondControl.y,
            tile.end.x,
            tile.end.y,
          );

          ctx.globalAlpha = lineAlpha;
          ctx.strokeStyle = `rgb(${lineColor})`;
          ctx.stroke();

          for (const eye of tile.eyes) {
            ctx.beginPath();
            ctx.arc(eye.x, eye.y, 1.5, 0, Math.PI * 2);
            ctx.globalAlpha = fillAlpha;
            ctx.fillStyle = `rgb(${fillColor})`;
            ctx.fill();
            ctx.globalAlpha = eyeAlpha * tile.eyeStrokeStrength;
            ctx.fillStyle = `rgb(${eyeColor})`;
            ctx.fill();
          }
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

<div class="penguin-grid" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .penguin-grid {
    position: absolute;
    inset: 0;
    z-index: 0;
    --penguin-grid-line-rgb: 43, 43, 47;
    --penguin-grid-fill-rgb: 80, 90, 255;
    --penguin-grid-eye-rgb: 218, 218, 218;
    --penguin-grid-line-alpha: 0.68;
    --penguin-grid-fill-alpha: 0.055;
    --penguin-grid-eye-alpha: 0.16;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .penguin-grid {
    --penguin-grid-line-rgb: 236, 236, 238;
    --penguin-grid-fill-rgb: 0, 0, 255;
    --penguin-grid-eye-rgb: 0, 0, 0;
    --penguin-grid-line-alpha: 0.68;
    --penguin-grid-fill-alpha: 0.05;
    --penguin-grid-eye-alpha: 0.14;
  }
  :global([data-theme="dark"]) .penguin-grid {
    --penguin-grid-line-rgb: 43, 43, 47;
    --penguin-grid-fill-rgb: 92, 102, 255;
    --penguin-grid-eye-rgb: 218, 218, 218;
    --penguin-grid-line-alpha: 0.68;
    --penguin-grid-fill-alpha: 0.055;
    --penguin-grid-eye-alpha: 0.16;
  }
  @media (prefers-reduced-motion: reduce) {
    .penguin-grid {
      opacity: 0.82;
    }
  }
</style>
