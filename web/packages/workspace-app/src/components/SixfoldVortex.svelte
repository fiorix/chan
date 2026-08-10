<script lang="ts">
  import { onMount } from "svelte";
  import {
    advanceSixfoldVortexParticles,
    createSixfoldVortexParticles,
    createSixfoldVortexRenderer,
    fitSixfoldVortex,
    isSixfoldVortexPointDrawable,
    type SixfoldVortexRenderer,
  } from "./sixfoldVortex";
  import {
    canvasCssNumber,
    canvasCssRgb,
    runWebgl2Animation,
  } from "./canvasAnimation";

  const SOURCE_TIME_SPEED = 60;
  const SOURCE_FADE_ALPHA = 9 / 255;
  const MAX_FRAME_SCALE = 4;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(host, (gl) => {
      let renderer: SixfoldVortexRenderer;
      try {
        renderer = createSixfoldVortexRenderer(gl);
      } catch (error) {
        console.warn(
          "[chan] Sixfold Vortex WebGL renderer unavailable:",
          error,
        );
        return null;
      }

      let width = 0;
      let height = 0;
      let lastSimulationMs = 0;
      let sourceTime = 0;
      let particles = createSixfoldVortexParticles();
      let paintedBackground = "";
      const upload = new Float32Array(particles.length);

      function backgroundColor(): [number, number, number] {
        return canvasCssRgb(
          host,
          "--sixfold-vortex-background-rgb",
          "28, 28, 30",
        );
      }

      function resetSurface(): void {
        const background = backgroundColor();
        paintedBackground = background.join(",");
        renderer.resetSurface(background);
      }

      function drawParticles(fade: number): void {
        const pointColor = canvasCssRgb(
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

        // All particles share one upload. Excluding escaped particles keeps
        // vortex singularities from inflating the draw beyond the canvas.
        let pointCount = 0;
        for (let index = 0; index < particles.length; index += 2) {
          const pointX =
            transform.centerX + particles[index] * transform.scale;
          const pointY =
            transform.centerY + particles[index + 1] * transform.scale;
          if (
            !isSixfoldVortexPointDrawable(pointX, pointY, width, height)
          ) {
            continue;
          }
          upload[pointCount * 2] = particles[index];
          upload[pointCount * 2 + 1] = particles[index + 1];
          pointCount += 1;
        }

        renderer.draw({
          points: upload,
          pointCount,
          centerX: transform.centerX,
          centerY: transform.centerY,
          scale: transform.scale,
          backgroundColor: backgroundColor(),
          pointColor,
          pointAlpha,
          fade,
        });
      }

      function draw(frameScale: number): void {
        if (width <= 0 || height <= 0) return;
        if (backgroundColor().join(",") !== paintedBackground) {
          resetSurface();
        }

        drawParticles(1 - Math.pow(1 - SOURCE_FADE_ALPHA, frameScale));
        advanceSixfoldVortexParticles(
          particles,
          sourceTime,
          frameScale,
        );
        sourceTime += frameScale;
      }

      function drawStatic(): void {
        resetSurface();
        drawParticles(0);
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
        destroy: renderer.destroy,
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
