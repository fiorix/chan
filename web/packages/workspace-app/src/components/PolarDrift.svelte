<script lang="ts">
  import { onMount } from "svelte";
  import {
    advancePolarDriftParticles,
    createPolarDriftParticles,
    createPolarDriftRenderer,
    fitPolarDrift,
    type PolarDriftRenderer,
  } from "./polarDrift";
  import {
    canvasCssNumber,
    canvasCssRgb,
    runWebgl2Animation,
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

    return runWebgl2Animation(host, (gl) => {
      let renderer: PolarDriftRenderer;
      try {
        renderer = createPolarDriftRenderer(gl);
      } catch (error) {
        console.warn("[chan] Polar Drift WebGL renderer unavailable:", error);
        return null;
      }

      let width = 0;
      let height = 0;
      let lastSimulationMs = 0;
      let particles = createPolarDriftParticles();
      let paintedBackground = "";

      function backgroundColor(): [number, number, number] {
        return canvasCssRgb(
          host,
          "--polar-drift-background-rgb",
          "28, 28, 30",
        );
      }

      function resetSurface(): void {
        const background = backgroundColor();
        paintedBackground = background.join(",");
        renderer.resetSurface(background);
      }

      /// One pass of the particle field onto the trail surface. `fade` is the
      /// frame's decay and belongs to the FIRST pass only: the 2D version faded
      /// once per frame and then drew every simulation sub-step onto the faded
      /// surface, so a later sub-step passing 0 reproduces that exactly.
      ///
      /// Every particle is uploaded. Unlike the vortex there is no cull to do:
      /// `advancePolarDriftParticles` respawns anything outside the disc, so
      /// the field is bounded by construction and the whole array is on-canvas.
      function drawParticles(fade: number): void {
        const pointColor = canvasCssRgb(
          host,
          "--polar-drift-point-rgb",
          "105, 105, 112",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--polar-drift-point-alpha",
          0.26,
        );
        const transform = fitPolarDrift(width, height);

        renderer.draw({
          points: particles,
          pointCount: particles.length / 2,
          centerX: transform.centerX,
          centerY: transform.centerY,
          scaleX: transform.scaleX,
          scaleY: transform.scaleY,
          backgroundColor: backgroundColor(),
          pointColor,
          pointAlpha,
          fade,
        });
      }

      function draw(phase: number, frameScale: number): void {
        if (width <= 0 || height <= 0) return;
        if (backgroundColor().join(",") !== paintedBackground) resetSurface();

        const fade = 1 - Math.pow(1 - SOURCE_FADE_ALPHA, frameScale);
        const steps = Math.max(1, Math.ceil(frameScale));
        const distance = frameScale / steps;
        for (let step = 0; step < steps; step += 1) {
          drawParticles(step === 0 ? fade : 0);
          advancePolarDriftParticles(particles, phase, distance);
        }
      }

      function drawStatic(): void {
        resetSurface();
        drawParticles(0);
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
