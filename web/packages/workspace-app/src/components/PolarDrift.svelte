<script lang="ts">
  import { onMount } from "svelte";
  import {
    advancePolarDriftParticles,
    createPolarDriftParticles,
    POLAR_DRIFT_HALF_SIZE,
  } from "./polarDrift";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const PHASE_SPEED = 0.06;
  const SOURCE_FRAMES_PER_SECOND = 60;
  const SOURCE_FADE_ALPHA = 5 / 255;
  const MAX_FRAME_SCALE = 4;
  const STATIC_PHASE = Math.PI / 3;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let lastSimulationMs = 0;
      let particles = createPolarDriftParticles();
      let paintedBackground = "";

      function backgroundColor(): string {
        return canvasCssValue(
          host,
          "--polar-drift-background-rgb",
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
          "--polar-drift-point-rgb",
          "105, 105, 112",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--polar-drift-point-alpha",
          0.26,
        );
        const scaleX = width / (POLAR_DRIFT_HALF_SIZE * 2);
        const scaleY = height / (POLAR_DRIFT_HALF_SIZE * 2);

        ctx.beginPath();
        for (let index = 0; index < particles.length; index += 2) {
          ctx.rect(
            width / 2 + particles[index] * scaleX,
            height / 2 + particles[index + 1] * scaleY,
            1,
            1,
          );
        }
        ctx.globalAlpha = pointAlpha;
        ctx.fillStyle = `rgb(${pointColor})`;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      function draw(phase: number, frameScale: number): void {
        if (width <= 0 || height <= 0) return;
        if (backgroundColor() !== paintedBackground) resetSurface();

        ctx.globalAlpha =
          1 - Math.pow(1 - SOURCE_FADE_ALPHA, frameScale);
        ctx.fillStyle = `rgb(${backgroundColor()})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1;

        const steps = Math.max(1, Math.ceil(frameScale));
        const distance = frameScale / steps;
        for (let step = 0; step < steps; step += 1) {
          drawParticles();
          advancePolarDriftParticles(particles, phase, distance);
        }
      }

      function drawStatic(): void {
        resetSurface();
        drawParticles();
      }

      function drawAt(timeMs: number): void {
        const elapsedMs =
          lastSimulationMs === 0
            ? 1000 / SOURCE_FRAMES_PER_SECOND
            : timeMs - lastSimulationMs;
        const frameScale = Math.min(
          MAX_FRAME_SCALE,
          (elapsedMs * SOURCE_FRAMES_PER_SECOND) / 1000,
        );
        lastSimulationMs = timeMs;
        draw(timeMs * 0.001 * PHASE_SPEED, frameScale);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          particles = createPolarDriftParticles();
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

<div class="polar-drift" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .polar-drift {
    position: absolute;
    inset: 0;
    z-index: 0;
    --polar-drift-background-rgb: 28, 28, 30;
    --polar-drift-point-rgb: 105, 105, 112;
    --polar-drift-point-alpha: 0.26;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .polar-drift {
    --polar-drift-background-rgb: 255, 255, 255;
    --polar-drift-point-rgb: 80, 80, 86;
    --polar-drift-point-alpha: 0.22;
  }
  :global([data-theme="dark"]) .polar-drift {
    --polar-drift-background-rgb: 28, 28, 30;
    --polar-drift-point-rgb: 105, 105, 112;
    --polar-drift-point-alpha: 0.26;
  }
  @media (prefers-reduced-motion: reduce) {
    .polar-drift {
      opacity: 0.82;
    }
  }
</style>
