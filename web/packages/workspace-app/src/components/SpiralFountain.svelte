<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    canvasCssRgb,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createSpiralFountainRenderer,
    type SpiralFountainRenderer,
  } from "./spiralFountain";

  // The sketch runs at 60 frames a second; this runs at a quarter of that.
  const SOURCE_FRAMES_PER_SECOND = 15;
  const SOURCE_FADE_ALPHA = 9 / 255;
  // The source frames one paint stamps, so a trail stays unbroken at the
  // fastest speed and a stall is not replayed.
  const MAX_STAMPS = 8;
  // The still shown under reduced motion: the picture at this source frame,
  // with the trails the paints before it would have left.
  const STATIC_TIME = 700;
  const STATIC_PAINTS = 48;
  const STATIC_PAINT_FRAMES = 2;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(host, (gl) => {
      let renderer: SpiralFountainRenderer;
      try {
        renderer = createSpiralFountainRenderer(gl);
      } catch (error) {
        console.warn(
          "[chan] Spiral Fountain WebGL renderer unavailable:",
          error,
        );
        return null;
      }

      let lastTime: number | null = null;
      let paintedBackground = "";

      function backgroundColor(): [number, number, number] {
        return canvasCssRgb(
          host,
          "--spiral-fountain-background-rgb",
          "28, 28, 30",
        );
      }

      function resetSurface(): void {
        const background = backgroundColor();
        paintedBackground = background.join(",");
        renderer.resetSurface(background);
      }

      function paint(times: readonly number[], frames: number): void {
        if (backgroundColor().join(",") !== paintedBackground) resetSurface();
        renderer.draw({
          times,
          fade: 1 - Math.pow(1 - SOURCE_FADE_ALPHA, frames),
          fieldScale: canvasCssNumber(
            host,
            "--spiral-fountain-field-scale",
            0.65,
          ),
          backgroundColor: backgroundColor(),
          tone: canvasCssNumber(host, "--spiral-fountain-tone", 0.53),
          opacity: canvasCssNumber(
            host,
            "--spiral-fountain-opacity",
            0.395,
          ),
        });
      }

      function drawAt(timeMs: number): void {
        const time = timeMs * 0.001 * SOURCE_FRAMES_PER_SECOND;
        const elapsed = lastTime === null ? 0 : Math.max(0, time - lastTime);
        lastTime = time;

        const span = Math.min(elapsed, MAX_STAMPS);
        const stamps = Math.max(1, Math.ceil(span));
        const times: number[] = [];
        for (let stamp = 1; stamp <= stamps; stamp += 1) {
          times.push(time - span + (span * stamp) / stamps);
        }
        paint(times, elapsed);
      }

      function drawStatic(): void {
        resetSurface();
        for (let step = STATIC_PAINTS - 1; step >= 0; step -= 1) {
          paint(
            [STATIC_TIME - step * STATIC_PAINT_FRAMES],
            STATIC_PAINT_FRAMES,
          );
        }
      }

      return {
        resize(_width, _height, reducedMotion, timeMs) {
          lastTime = null;
          if (reducedMotion) {
            drawStatic();
          } else {
            resetSurface();
            drawAt(timeMs);
          }
        },
        frame: drawAt,
        reducedMotion: drawStatic,
        start: () => {
          lastTime = null;
        },
        destroy: renderer.destroy,
      };
    });
  });
</script>

<div class="spiral-fountain" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .spiral-fountain {
    position: absolute;
    inset: 0;
    z-index: 0;
    --spiral-fountain-background-rgb: 28, 28, 30;
    --spiral-fountain-field-scale: 0.65;
    --spiral-fountain-tone: 0.53;
    --spiral-fountain-opacity: 0.395;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .spiral-fountain {
    --spiral-fountain-background-rgb: 255, 255, 255;
    --spiral-fountain-tone: 0;
    --spiral-fountain-opacity: 0.16;
  }
  :global([data-theme="dark"]) .spiral-fountain {
    --spiral-fountain-background-rgb: 28, 28, 30;
    --spiral-fountain-tone: 0.53;
    --spiral-fountain-opacity: 0.395;
  }
  @media (prefers-reduced-motion: reduce) {
    .spiral-fountain {
      opacity: 0.82;
    }
  }
</style>
