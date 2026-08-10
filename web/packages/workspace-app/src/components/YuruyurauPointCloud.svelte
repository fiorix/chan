<script lang="ts">
  import { onMount } from "svelte";
  import { type PointCloudBounds } from "./pointCloudCover";
  import {
    canvasCssNumber,
    canvasCssRgb,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createYuruyurauPointCloudRenderer,
    type YuruyurauPointCloudRenderer,
  } from "./yuruyurauPointCloud";

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

    return runWebgl2Animation(host, (gl) => {
      let renderer: YuruyurauPointCloudRenderer;
      try {
        renderer = createYuruyurauPointCloudRenderer(gl);
      } catch (error) {
        console.warn(
          "[chan] Yuruyurau point cloud WebGL renderer unavailable:",
          error,
        );
        return null;
      }

      let width = 0;
      let height = 0;

      function draw(sourceTime: number): void {
        if (width <= 0 || height <= 0) return;

        renderer.draw({
          points: buildPoints(sourceTime),
          bounds,
          backgroundColor: canvasCssRgb(
            host,
            "--yuruyurau-background-rgb",
            "28, 28, 30",
          ),
          pointColor: canvasCssRgb(
            host,
            "--yuruyurau-point-rgb",
            "218, 218, 218",
          ),
          pointAlpha: canvasCssNumber(
            host,
            "--yuruyurau-point-alpha",
            0.376,
          ),
        });
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
        destroy: renderer.destroy,
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
