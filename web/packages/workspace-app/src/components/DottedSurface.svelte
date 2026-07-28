<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const TAU = Math.PI * 2;
  // Wave/grid constants follow the 21st.dev dotted-surface reference.
  // Source: https://21st.dev/@efferd/components/dotted-surface
  const AMOUNT_X = 40;
  const AMOUNT_Y = 60;
  const SEPARATION = 150;
  const CAMERA_Y = 355;
  const CAMERA_Z = 1220;
  const FOV_RAD = (60 * Math.PI) / 180;
  const POINT_SIZE = 6.4;
  const WAVE_SPEED = 1.45;
  const HORIZON_RATIO = -0.05;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(timeMs: number): void {
        if (width <= 0 || height <= 0) return;

        const count = timeMs * 0.001 * WAVE_SPEED;
        const dotColor = canvasCssValue(
          host,
          "--dotted-surface-dot-rgb",
          "200, 200, 200",
        );
        const alphaBase = canvasCssNumber(
          host,
          "--dotted-surface-alpha-base",
          0.18,
        );
        const alphaRange = canvasCssNumber(
          host,
          "--dotted-surface-alpha-range",
          0.42,
        );
        const sizeScale = canvasCssNumber(
          host,
          "--dotted-surface-size-scale",
          0.94,
        );
        const focal = (height * 1.28) / (2 * Math.tan(FOV_RAD / 2));
        const horizon = height * HORIZON_RATIO;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = `rgb(${dotColor})`;

        for (let iy = 0; iy < AMOUNT_Y; iy += 1) {
          const worldZ = iy * SEPARATION - (AMOUNT_Y * SEPARATION) / 2;
          const zView = CAMERA_Z - worldZ;
          if (zView <= 0) continue;

          const perspective = focal / zView;
          const depth = iy / (AMOUNT_Y - 1);

          for (let ix = 0; ix < AMOUNT_X; ix += 1) {
            const worldX = ix * SEPARATION - (AMOUNT_X * SEPARATION) / 2;
            const worldY =
              Math.sin((ix + count) * 0.3) * 50 +
              Math.sin((iy + count) * 0.5) * 50;
            const x = width / 2 + worldX * perspective;
            const y = horizon + (CAMERA_Y - worldY) * perspective;
            if (x < -10 || x > width + 10 || y < -10 || y > height + 10) {
              continue;
            }

            const radius = Math.min(
              3.8,
              Math.max(0.85, POINT_SIZE * perspective * sizeScale),
            );
            ctx.globalAlpha = alphaBase + depth * alphaRange;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, TAU);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }

      return {
        resize(nextWidth, nextHeight, _reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          draw(timeMs);
        },
        frame: draw,
        reducedMotion: () => draw(performance.now()),
      };
    });
  });
</script>

<div class="dotted-surface" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .dotted-surface {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: clamp(260px, 33%, 400px);
    z-index: 0;
    --dotted-surface-dot-rgb: 200, 200, 200;
    --dotted-surface-alpha-base: 0.18;
    --dotted-surface-alpha-range: 0.42;
    --dotted-surface-size-scale: 0.94;
    pointer-events: none;
    overflow: hidden;
    opacity: 1;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .dotted-surface {
    --dotted-surface-dot-rgb: 0, 0, 0;
    --dotted-surface-alpha-base: 0.13;
    --dotted-surface-alpha-range: 0.32;
    --dotted-surface-size-scale: 0.9;
  }
  :global([data-theme="dark"]) .dotted-surface {
    --dotted-surface-dot-rgb: 218, 218, 218;
    --dotted-surface-alpha-base: 0.18;
    --dotted-surface-alpha-range: 0.42;
    --dotted-surface-size-scale: 0.94;
  }
  @media (prefers-reduced-motion: reduce) {
    .dotted-surface {
      opacity: 0.8;
    }
  }
</style>
