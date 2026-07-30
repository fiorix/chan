<script lang="ts">
  import { onMount } from "svelte";
  import {
    advanceMutualForceParticles,
    createMutualForceParticles,
    createMutualForceStaticSnapshot,
    fitMutualForceStarburst,
  } from "./mutualForceStarburst";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const SOURCE_FRAMES_PER_SECOND = 60;
  const SOURCE_FADE_ALPHA = 9 / 255;
  const MAX_SOURCE_STEPS_PER_FRAME = 4;
  const STATIC_TRAIL_STEPS = 5;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;
      let lastSimulationMs = 0;
      let pendingSourceFrames = 0;
      let particles = createMutualForceParticles();
      let paintedBackground = "";

      function backgroundColor(): string {
        return canvasCssValue(
          host,
          "--mutual-force-starburst-background-rgb",
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

      function drawParticles(
        source: Float32Array,
        alphaScale = 1,
        positionScale = 1,
      ): void {
        const pointColor = canvasCssValue(
          host,
          "--mutual-force-starburst-point-rgb",
          "238, 238, 238",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--mutual-force-starburst-point-alpha",
          0.38,
        );
        const transform = fitMutualForceStarburst(width, height);
        const radius = Math.max(0.7, 1.5 * transform.scale);

        ctx.beginPath();
        for (let offset = 0; offset < source.length; offset += 4) {
          const x =
            transform.centerX +
            source[offset] * transform.scale * positionScale;
          const y =
            transform.centerY +
            source[offset + 1] * transform.scale * positionScale;
          ctx.moveTo(x + radius, y);
          ctx.arc(x, y, radius, 0, Math.PI * 2);
        }
        ctx.globalAlpha = pointAlpha * alphaScale;
        ctx.strokeStyle = `rgb(${pointColor})`;
        ctx.lineWidth = Math.max(0.65, transform.scale);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      function drawSourceFrame(): void {
        if (backgroundColor() !== paintedBackground) resetSurface();

        ctx.globalAlpha = SOURCE_FADE_ALPHA;
        ctx.fillStyle = `rgb(${backgroundColor()})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1;

        // Reflect at the pane's own edges so the web reaches the sides.
        const transform = fitMutualForceStarburst(width, height);
        advanceMutualForceParticles(
          particles,
          width / 2 / transform.scale,
          height / 2 / transform.scale,
        );
        drawParticles(particles);
      }

      function drawStatic(): void {
        if (width <= 0 || height <= 0) return;
        resetSurface();
        const snapshot = createMutualForceStaticSnapshot(particles);

        for (let step = 1; step <= STATIC_TRAIL_STEPS; step += 1) {
          drawParticles(
            snapshot,
            0.42 + (step / STATIC_TRAIL_STEPS) * 0.58,
            step / STATIC_TRAIL_STEPS,
          );
        }
      }

      function drawAt(timeMs: number): void {
        if (width <= 0 || height <= 0) return;
        const elapsedMs =
          lastSimulationMs === 0
            ? 1000 / SOURCE_FRAMES_PER_SECOND
            : timeMs - lastSimulationMs;
        lastSimulationMs = timeMs;
        pendingSourceFrames = Math.min(
          MAX_SOURCE_STEPS_PER_FRAME,
          pendingSourceFrames +
            (elapsedMs * SOURCE_FRAMES_PER_SECOND) / 1000,
        );

        const steps = Math.floor(pendingSourceFrames);
        for (let step = 0; step < steps; step += 1) {
          drawSourceFrame();
        }
        pendingSourceFrames -= steps;
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          particles = createMutualForceParticles();
          lastSimulationMs = 0;
          pendingSourceFrames = 0;
          resetSurface();
          if (reducedMotion) drawStatic();
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: drawStatic,
        start: () => {
          lastSimulationMs = 0;
          pendingSourceFrames = 0;
        },
      };
    });
  });
</script>

<div class="mutual-force-starburst" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .mutual-force-starburst {
    position: absolute;
    inset: 0;
    z-index: 0;
    --mutual-force-starburst-background-rgb: 28, 28, 30;
    --mutual-force-starburst-point-rgb: 238, 238, 238;
    --mutual-force-starburst-point-alpha: 0.38;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .mutual-force-starburst {
    --mutual-force-starburst-background-rgb: 255, 255, 255;
    --mutual-force-starburst-point-rgb: 0, 0, 0;
    --mutual-force-starburst-point-alpha: 0.24;
  }
  :global([data-theme="dark"]) .mutual-force-starburst {
    --mutual-force-starburst-background-rgb: 28, 28, 30;
    --mutual-force-starburst-point-rgb: 238, 238, 238;
    --mutual-force-starburst-point-alpha: 0.38;
  }
  @media (prefers-reduced-motion: reduce) {
    .mutual-force-starburst {
      opacity: 0.82;
    }
  }
</style>
