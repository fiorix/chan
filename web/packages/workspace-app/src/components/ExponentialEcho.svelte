<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildExponentialEchoPoints,
    exponentialEchoTrailFade,
    EXPONENTIAL_ECHO_PHASE_PER_SECOND,
    EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
    fitExponentialEcho,
    wrapExponentialEchoPhase,
    type ExponentialEchoTransform,
  } from "./exponentialEcho";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const STATIC_PHASE = 1.2;
  const STATIC_ECHO_COUNT = 24;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(
      host,
      (ctx) => {
        let width = 0;
        let height = 0;
        let phase = 0;
        let lastSimulationMs = 0;
        let needsClear = true;

        function clear(): void {
          ctx.clearRect(0, 0, width, height);
        }

        function fadeTrails(alpha: number): void {
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.globalAlpha = alpha;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        }

        function drawThread(
          nextPhase: number,
          transform: ExponentialEchoTransform,
          lineColor: string,
          lineAlpha: number,
        ): void {
          const points = buildExponentialEchoPoints(nextPhase);

          ctx.save();
          ctx.strokeStyle = `rgb(${lineColor})`;
          ctx.globalAlpha = lineAlpha;
          ctx.lineWidth = Math.max(0.7, transform.scale);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(
            transform.centerX + points[0] * transform.scale,
            transform.centerY + points[1] * transform.scale,
          );
          for (let index = 2; index < points.length; index += 2) {
            ctx.lineTo(
              transform.centerX + points[index] * transform.scale,
              transform.centerY + points[index + 1] * transform.scale,
            );
          }
          ctx.stroke();
          ctx.restore();
        }

        function drawFrame(
          nextPhase: number,
          trailFade: number,
        ): void {
          if (width <= 0 || height <= 0) return;

          const lineColor = canvasCssValue(
            host,
            "--exponential-echo-line-rgb",
            "218, 218, 218",
          );
          const lineAlpha = canvasCssNumber(
            host,
            "--exponential-echo-line-alpha",
            0.18,
          );
          const transform = fitExponentialEcho(width, height);

          if (needsClear) {
            clear();
            needsClear = false;
          } else {
            fadeTrails(trailFade);
          }
          drawThread(nextPhase, transform, lineColor, lineAlpha);
        }

        function drawStatic(): void {
          if (width <= 0 || height <= 0) return;

          const lineColor = canvasCssValue(
            host,
            "--exponential-echo-line-rgb",
            "218, 218, 218",
          );
          const lineAlpha = canvasCssNumber(
            host,
            "--exponential-echo-line-alpha",
            0.18,
          );
          const transform = fitExponentialEcho(width, height);

          clear();
          for (let index = 0; index < STATIC_ECHO_COUNT; index += 1) {
            const age = STATIC_ECHO_COUNT - index - 1;
            drawThread(
              STATIC_PHASE - age * 0.001,
              transform,
              lineColor,
              lineAlpha *
                Math.pow(
                  1 - EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
                  age,
                ),
            );
          }
          needsClear = true;
        }

        function drawAt(timeMs: number): void {
          const elapsedMs =
            lastSimulationMs === 0
              ? 1000 / 60
              : Math.min(1000 / 15, timeMs - lastSimulationMs);
          lastSimulationMs = timeMs;
          const elapsedSeconds = elapsedMs / 1000;
          phase = wrapExponentialEchoPhase(
            phase +
              elapsedSeconds * EXPONENTIAL_ECHO_PHASE_PER_SECOND,
          );
          drawFrame(phase, exponentialEchoTrailFade(elapsedSeconds));
        }

        return {
          resize(nextWidth, nextHeight, reducedMotion, timeMs) {
            width = nextWidth;
            height = nextHeight;
            phase = 0;
            lastSimulationMs = 0;
            needsClear = true;
            if (reducedMotion) drawStatic();
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: drawStatic,
          start: () => {
            lastSimulationMs = 0;
            needsClear = true;
          },
        };
      },
      { frameRate: 30 },
    );
  });
</script>

<div class="exponential-echo" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .exponential-echo {
    position: absolute;
    inset: 0;
    z-index: 0;
    --exponential-echo-line-rgb: 218, 218, 218;
    --exponential-echo-line-alpha: 0.18;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .exponential-echo {
    --exponential-echo-line-rgb: 0, 0, 0;
    --exponential-echo-line-alpha: 0.14;
  }
  :global([data-theme="dark"]) .exponential-echo {
    --exponential-echo-line-rgb: 218, 218, 218;
    --exponential-echo-line-alpha: 0.18;
  }
  @media (prefers-reduced-motion: reduce) {
    .exponential-echo {
      opacity: 0.82;
    }
  }
</style>
