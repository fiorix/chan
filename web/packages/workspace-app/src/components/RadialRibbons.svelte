<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildRadialRibbons,
    fitRadialRibbons,
    type Point,
  } from "./radialRibbons";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = 0.0576;
  const STATIC_PHASE = 0.55;

  let canvas = $state<HTMLCanvasElement | undefined>();

  function traceCurve(
    ctx: CanvasRenderingContext2D,
    points: Point[],
  ): void {
    if (points.length < 4) return;
    ctx.moveTo(points[1].x, points[1].y);

    for (let index = 1; index < points.length - 2; index += 1) {
      const before = points[index - 1];
      const start = points[index];
      const end = points[index + 1];
      const after = points[index + 2];
      ctx.bezierCurveTo(
        start.x + (end.x - before.x) / 6,
        start.y + (end.y - before.y) / 6,
        end.x - (after.x - start.x) / 6,
        end.y - (after.y - start.y) / 6,
        end.x,
        end.y,
      );
    }
  }

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(phase: number): void {
        if (width <= 0 || height <= 0) return;

        const shapeColor = canvasCssValue(
          host,
          "--radial-ribbons-shape-rgb",
          "45, 45, 50",
        );
        const fillAlpha = canvasCssNumber(
          host,
          "--radial-ribbons-fill-alpha",
          0.72,
        );
        const strokeAlpha = canvasCssNumber(
          host,
          "--radial-ribbons-stroke-alpha",
          0.78,
        );
        const transform = fitRadialRibbons(width, height);
        const ribbons = buildRadialRibbons(phase);

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(transform.centerX, transform.centerY);
        ctx.scale(transform.scale, transform.scale);
        ctx.fillStyle = `rgb(${shapeColor})`;
        ctx.strokeStyle = `rgb(${shapeColor})`;
        ctx.lineWidth = 0.8 / transform.scale;
        ctx.lineJoin = "round";

        for (const ribbon of ribbons) {
          ctx.beginPath();
          traceCurve(ctx, ribbon);
          ctx.closePath();
          ctx.globalAlpha = fillAlpha;
          ctx.fill();
          ctx.globalAlpha = strokeAlpha;
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

<div class="radial-ribbons" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .radial-ribbons {
    position: absolute;
    inset: 0;
    z-index: 0;
    --radial-ribbons-shape-rgb: 45, 45, 50;
    --radial-ribbons-fill-alpha: 0.72;
    --radial-ribbons-stroke-alpha: 0.78;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .radial-ribbons {
    --radial-ribbons-shape-rgb: 235, 235, 239;
    --radial-ribbons-fill-alpha: 0.72;
    --radial-ribbons-stroke-alpha: 0.78;
  }
  :global([data-theme="dark"]) .radial-ribbons {
    --radial-ribbons-shape-rgb: 45, 45, 50;
    --radial-ribbons-fill-alpha: 0.72;
    --radial-ribbons-stroke-alpha: 0.78;
  }
  @media (prefers-reduced-motion: reduce) {
    .radial-ribbons {
      opacity: 0.82;
    }
  }
</style>
