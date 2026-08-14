<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    canvasCssRgb,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createYuruyurauRotationalRenderer,
    type YuruyurauRotationalRenderer,
  } from "./yuruyurauRotationalField";

  let {
    buildBasePoints,
    rotationCount,
    sourceTimePerMs,
    centerFadeRadius,
  }: {
    buildBasePoints: (
      sourceTime: number,
      target?: Float32Array,
    ) => Float32Array;
    rotationCount: number;
    sourceTimePerMs: number;
    centerFadeRadius: number;
  } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(host, (gl) => {
      let renderer: YuruyurauRotationalRenderer;
      try {
        renderer = createYuruyurauRotationalRenderer(gl);
      } catch (error) {
        console.warn(
          "[chan] Yuruyurau rotational field WebGL renderer unavailable:",
          error,
        );
        return null;
      }

      let width = 0;
      let height = 0;
      let points: Float32Array | undefined;

      function draw(sourceTime: number): void {
        if (width <= 0 || height <= 0) return;

        const backgroundColor = canvasCssRgb(
          host,
          "--yuruyurau-background-rgb",
          "28, 28, 30",
        );
        const pointColor = canvasCssRgb(
          host,
          "--yuruyurau-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--yuruyurau-rotational-point-alpha",
          46 / 255,
        );
        // The build reuses one buffer across frames; the renderer reuses
        // one upload buffer, so a frame allocates nothing.
        points = buildBasePoints(sourceTime, points);
        renderer.draw({
          points,
          rotationCount,
          backgroundColor,
          pointColor,
          pointAlpha,
          fadeInnerRadius: Math.min(76, centerFadeRadius * 0.55),
          fadeOuterRadius: centerFadeRadius,
        });
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * sourceTimePerMs);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(0);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(0),
        destroy: renderer.destroy,
      };
    });
  });
</script>

<div class="yuruyurau-rotational-field" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .yuruyurau-rotational-field {
    position: absolute;
    inset: 0;
    z-index: 0;
    --yuruyurau-background-rgb: 28, 28, 30;
    --yuruyurau-point-rgb: 218, 218, 218;
    --yuruyurau-rotational-point-alpha: 0.1804;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .yuruyurau-rotational-field {
    --yuruyurau-background-rgb: 255, 255, 255;
    --yuruyurau-point-rgb: 0, 0, 0;
    --yuruyurau-rotational-point-alpha: 0.17;
  }
  @media (prefers-reduced-motion: reduce) {
    .yuruyurau-rotational-field {
      opacity: 0.82;
    }
  }
</style>
