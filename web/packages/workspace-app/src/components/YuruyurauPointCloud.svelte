<script lang="ts">
  import { onMount } from "svelte";
  import {
    fitPointCloudCover,
    type PointCloudBounds,
  } from "./pointCloudCover";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  let {
    buildPoints,
    bounds,
    sourceTimePerMs,
    staticSourceTime = 0,
  }: {
    buildPoints: (sourceTime: number) => Float32Array;
    bounds: PointCloudBounds;
    sourceTimePerMs: number;
    staticSourceTime?: number;
  } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(sourceTime: number): void {
        if (width <= 0 || height <= 0) return;

        const backgroundColor = canvasCssValue(
          host,
          "--yuruyurau-background-rgb",
          "28, 28, 30",
        );
        const pointColor = canvasCssValue(
          host,
          "--yuruyurau-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--yuruyurau-point-alpha",
          0.376,
        );
        const points = buildPoints(sourceTime);
        const transform = fitPointCloudCover(width, height, bounds);
        const pointSize = Math.max(
          0.75,
          Math.min(1.25, transform.scale),
        );

        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${backgroundColor})`;
        ctx.fillRect(0, 0, width, height);
        ctx.beginPath();

        for (let index = 0; index < points.length; index += 2) {
          const x =
            transform.centerX +
            (points[index] - transform.sourceCenterX) * transform.scale;
          const y =
            transform.centerY +
            (points[index + 1] - transform.sourceCenterY) * transform.scale;
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < -pointSize ||
            x > width + pointSize ||
            y < -pointSize ||
            y > height + pointSize
          ) {
            continue;
          }
          ctx.rect(
            x - pointSize / 2,
            y - pointSize / 2,
            pointSize,
            pointSize,
          );
        }

        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * sourceTimePerMs);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(staticSourceTime);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(staticSourceTime),
      };
    });
  });
</script>

<div class="yuruyurau-point-cloud" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .yuruyurau-point-cloud {
    position: absolute;
    inset: 0;
    z-index: 0;
    --yuruyurau-background-rgb: 28, 28, 30;
    --yuruyurau-point-rgb: 218, 218, 218;
    --yuruyurau-point-alpha: 0.376;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .yuruyurau-point-cloud {
    --yuruyurau-background-rgb: 255, 255, 255;
    --yuruyurau-point-rgb: 0, 0, 0;
    --yuruyurau-point-alpha: 0.28;
  }
  @media (prefers-reduced-motion: reduce) {
    .yuruyurau-point-cloud {
      opacity: 0.82;
    }
  }
</style>
