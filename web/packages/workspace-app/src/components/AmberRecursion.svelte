<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createAmberRecursionRenderer,
    type AmberRecursionRenderer,
  } from "./amberRecursion";

  const STATIC_TIME_SECONDS = 3.25;
  const TIME_SCALE = 0.25;
  const MAX_RENDER_PIXELS = 130_000;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: AmberRecursionRenderer;
        try {
          renderer = createAmberRecursionRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Amber Recursion WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        function draw(timeSeconds: number): void {
          const fieldScale = canvasCssNumber(
            host,
            "--amber-recursion-field-scale",
            1,
          );
          const tone = canvasCssNumber(
            host,
            "--amber-recursion-tone",
            0.855,
          );
          const opacity = canvasCssNumber(
            host,
            "--amber-recursion-opacity",
            0.41,
          );
          const exposure = canvasCssNumber(
            host,
            "--amber-recursion-exposure",
            1.6,
          );
          renderer.draw(
            timeSeconds,
            fieldScale,
            tone,
            opacity,
            exposure,
          );
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * TIME_SCALE);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_TIME_SECONDS);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_TIME_SECONDS),
          destroy: renderer.destroy,
        };
      },
      {
        frameRate: 20,
        maxDpr: 1,
        maxPixels: MAX_RENDER_PIXELS,
      },
    );
  });
</script>

<div class="amber-recursion" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .amber-recursion {
    position: absolute;
    inset: 0;
    z-index: 0;
    --amber-recursion-field-scale: 1;
    --amber-recursion-tone: 0.855;
    --amber-recursion-opacity: 0.41;
    --amber-recursion-exposure: 1.6;
    background-color: rgb(28, 28, 30);
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .amber-recursion {
    --amber-recursion-tone: 0;
    --amber-recursion-opacity: 0.28;
    --amber-recursion-exposure: 1.2;
    background-color: rgb(255, 255, 255);
  }
  :global([data-theme="dark"]) .amber-recursion {
    --amber-recursion-tone: 0.855;
    --amber-recursion-opacity: 0.41;
    --amber-recursion-exposure: 1.6;
    background-color: rgb(28, 28, 30);
  }
  @media (prefers-reduced-motion: reduce) {
    .amber-recursion {
      opacity: 0.84;
    }
  }
</style>
