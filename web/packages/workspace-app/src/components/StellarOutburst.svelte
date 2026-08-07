<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createStellarOutburstRenderer,
    type StellarOutburstRenderer,
  } from "./stellarOutburst";

  const STATIC_TIME_SECONDS = 3.75;
  const TIME_SCALE = 0.25;
  const MAX_RENDER_PIXELS = 130_000;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: StellarOutburstRenderer;
        try {
          renderer = createStellarOutburstRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Stellar Outburst WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        function draw(timeSeconds: number): void {
          const fieldScale = canvasCssNumber(
            host,
            "--stellar-outburst-field-scale",
            1.45,
          );
          const tone = canvasCssNumber(
            host,
            "--stellar-outburst-tone",
            0.855,
          );
          const opacity = canvasCssNumber(
            host,
            "--stellar-outburst-opacity",
            0.352,
          );
          renderer.draw(timeSeconds, fieldScale, tone, opacity);
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

<div class="stellar-outburst" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .stellar-outburst {
    position: absolute;
    inset: 0;
    z-index: 0;
    --stellar-outburst-tone: 0.855;
    --stellar-outburst-opacity: 0.352;
    --stellar-outburst-field-scale: 1.45;
    background-color: rgb(28, 28, 30);
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .stellar-outburst {
    --stellar-outburst-tone: 0;
    --stellar-outburst-opacity: 0.066;
    background-color: rgb(255, 255, 255);
  }
  :global([data-theme="dark"]) .stellar-outburst {
    --stellar-outburst-tone: 0.855;
    --stellar-outburst-opacity: 0.352;
    background-color: rgb(28, 28, 30);
  }
  @media (prefers-reduced-motion: reduce) {
    .stellar-outburst {
      opacity: 0.84;
    }
  }
</style>
