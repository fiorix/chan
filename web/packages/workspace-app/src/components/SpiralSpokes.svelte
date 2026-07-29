<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildSpiralSpokes,
    fitSpiralSpokes,
    spiralSpokesOpacity,
  } from "./spiralSpokes";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const SOURCE_STEPS_PER_SECOND = 1;
  const STATIC_STEP = 18;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let sourceStep = 0;
      let lastFrameMs = 0;

      function draw(step: number): void {
        if (width <= 0 || height <= 0) return;

        const lineColor = canvasCssValue(
          host,
          "--spiral-spokes-line-rgb",
          "218, 218, 224",
        );
        const lineAlpha = canvasCssNumber(
          host,
          "--spiral-spokes-line-alpha",
          0.42,
        );
        const transform = fitSpiralSpokes(width, height);
        const sourceOpacity = spiralSpokesOpacity(step);
        const spokes = sourceOpacity > 0 ? buildSpiralSpokes(step) : [];

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(transform.centerX, transform.centerY);
        ctx.scale(transform.scale, transform.scale);
        ctx.strokeStyle = `rgb(${lineColor})`;
        ctx.globalAlpha = lineAlpha * sourceOpacity;
        ctx.lineWidth = 1 / transform.scale;

        for (const spoke of spokes) {
          ctx.beginPath();
          ctx.moveTo(spoke.start.x, spoke.start.y);
          ctx.lineTo(spoke.end.x, spoke.end.y);
          ctx.stroke();
        }

        ctx.restore();
        ctx.globalAlpha = 1;
      }

      function drawAt(timeMs: number): void {
        if (lastFrameMs !== 0) {
          sourceStep +=
            ((timeMs - lastFrameMs) / 1000) *
            SOURCE_STEPS_PER_SECOND;
        }
        lastFrameMs = timeMs;
        draw(sourceStep);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(STATIC_STEP);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(STATIC_STEP),
        start: () => {
          lastFrameMs = 0;
        },
      };
    });
  });
</script>

<div class="spiral-spokes" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .spiral-spokes {
    position: absolute;
    inset: 0;
    z-index: 0;
    --spiral-spokes-line-rgb: 218, 218, 224;
    --spiral-spokes-line-alpha: 0.42;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .spiral-spokes {
    --spiral-spokes-line-rgb: 24, 24, 28;
    --spiral-spokes-line-alpha: 0.26;
  }
  :global([data-theme="dark"]) .spiral-spokes {
    --spiral-spokes-line-rgb: 218, 218, 224;
    --spiral-spokes-line-alpha: 0.42;
  }
  @media (prefers-reduced-motion: reduce) {
    .spiral-spokes {
      opacity: 0.82;
    }
  }
</style>
