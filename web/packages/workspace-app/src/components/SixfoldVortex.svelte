<script lang="ts">
  import { onMount } from "svelte";
  import {
    advanceSixfoldVortexParticles,
    createSixfoldVortexParticles,
    fitSixfoldVortex,
  } from "./sixfoldVortex";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const SOURCE_TIME_SPEED = 60;
  const SOURCE_FADE_ALPHA = 9 / 255;
  const MAX_FRAME_SCALE = 4;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let lastSimulationMs = 0;
      let sourceTime = 0;
      let particles = createSixfoldVortexParticles();
      let paintedBackground = "";

      function backgroundColor(): string {
        return canvasCssValue(
          host,
          "--sixfold-vortex-background-rgb",
          "28, 28, 30",
        );
      }

      function resetSurface(): void {
        paintedBackground = backgroundColor();
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${paintedBackground})`;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }

      function drawParticles(): void {
        const pointColor = canvasCssValue(
          host,
          "--sixfold-vortex-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--sixfold-vortex-point-alpha",
          0.088,
        );
        const transform = fitSixfoldVortex(width, height);

        ctx.beginPath();
        for (let index = 0; index < particles.length; index += 2) {
          ctx.rect(
            transform.centerX + particles[index] * transform.scale,
            transform.centerY + particles[index + 1] * transform.scale,
            1,
            1,
          );
        }
        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      function draw(frameScale: number): void {
        if (width <= 0 || height <= 0) return;
        if (backgroundColor() !== paintedBackground) resetSurface();

        ctx.globalAlpha =
          1 - Math.pow(1 - SOURCE_FADE_ALPHA, frameScale);
        ctx.fillStyle = `rgb(${backgroundColor()})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1;

        drawParticles();
        advanceSixfoldVortexParticles(
          particles,
          sourceTime,
          frameScale,
        );
        sourceTime += frameScale;
      }

      function drawStatic(): void {
        resetSurface();
        drawParticles();
      }

      function drawAt(timeMs: number): void {
        const elapsedMs =
          lastSimulationMs === 0
            ? 1000 / SOURCE_TIME_SPEED
            : Math.max(0, timeMs - lastSimulationMs);
        const frameScale = Math.min(
          MAX_FRAME_SCALE,
          (elapsedMs * SOURCE_TIME_SPEED) / 1000,
        );
        lastSimulationMs = timeMs;
        draw(frameScale);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          lastSimulationMs = 0;
          resetSurface();
          if (reducedMotion) drawStatic();
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: drawStatic,
        start: () => {
          lastSimulationMs = 0;
        },
      };
    });
  });
</script>

<div class="sixfold-vortex" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .sixfold-vortex {
    position: absolute;
    inset: 0;
    z-index: 0;
    --sixfold-vortex-background-rgb: 28, 28, 30;
    --sixfold-vortex-point-rgb: 218, 218, 218;
    --sixfold-vortex-point-alpha: 0.088;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .sixfold-vortex {
    --sixfold-vortex-background-rgb: 255, 255, 255;
    --sixfold-vortex-point-rgb: 0, 0, 0;
    --sixfold-vortex-point-alpha: 0.066;
  }
  :global([data-theme="dark"]) .sixfold-vortex {
    --sixfold-vortex-background-rgb: 28, 28, 30;
    --sixfold-vortex-point-rgb: 218, 218, 218;
    --sixfold-vortex-point-alpha: 0.088;
  }
  @media (prefers-reduced-motion: reduce) {
    .sixfold-vortex {
      opacity: 0.82;
    }
  }
</style>
