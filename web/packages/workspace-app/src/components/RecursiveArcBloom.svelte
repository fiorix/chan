<script lang="ts">
  import { onMount } from "svelte";
  import {
    buildRecursiveArcBloom,
    fitRecursiveArcBloom,
  } from "./recursiveArcBloom";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";

  const NOISE_PHASE_SPEED = 1 / 18;
  const STATIC_PHASE = 2.5;
  // The bloom's central void must contain the 160px welcome enso with
  // breathing room; screen px convert to sketch units by the live scale.
  const MARK_CLEARANCE_PX = 104;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(noisePhase: number): void {
        if (width <= 0 || height <= 0) return;

        const arcColor = canvasCssValue(
          host,
          "--recursive-arc-bloom-rgb",
          "218, 218, 218",
        );
        const arcAlpha = canvasCssNumber(
          host,
          "--recursive-arc-bloom-alpha",
          0.12,
        );
        const transform = fitRecursiveArcBloom(width, height);
        const arcs = buildRecursiveArcBloom(
          noisePhase,
          MARK_CLEARANCE_PX / transform.scale,
        );

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(transform.centerX, transform.centerY);
        ctx.scale(transform.scale, transform.scale);
        ctx.fillStyle = `rgb(${arcColor})`;
        ctx.strokeStyle = `rgb(${arcColor})`;
        ctx.globalAlpha = arcAlpha;
        ctx.lineWidth = 1 / transform.scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        for (const arc of arcs) {
          const radius = arc.diameter / 2;
          ctx.moveTo(arc.x, arc.y);
          ctx.lineTo(
            arc.x + Math.cos(arc.startAngle) * radius,
            arc.y + Math.sin(arc.startAngle) * radius,
          );
          ctx.arc(
            arc.x,
            arc.y,
            radius,
            arc.startAngle,
            arc.endAngle,
          );
          ctx.closePath();
        }
        ctx.fill();

        ctx.beginPath();
        for (const arc of arcs) {
          const radius = arc.diameter / 2;
          ctx.moveTo(
            arc.x + Math.cos(arc.startAngle) * radius,
            arc.y + Math.sin(arc.startAngle) * radius,
          );
          ctx.arc(
            arc.x,
            arc.y,
            radius,
            arc.startAngle,
            arc.endAngle,
          );
        }
        ctx.stroke();

        ctx.restore();
        ctx.globalAlpha = 1;
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * 0.001 * NOISE_PHASE_SPEED);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(STATIC_PHASE);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(STATIC_PHASE),
      };
    });
  });
</script>

<div class="recursive-arc-bloom" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .recursive-arc-bloom {
    position: absolute;
    inset: 0;
    z-index: 0;
    --recursive-arc-bloom-rgb: 218, 218, 218;
    --recursive-arc-bloom-alpha: 0.12;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .recursive-arc-bloom {
    --recursive-arc-bloom-rgb: 0, 0, 0;
    --recursive-arc-bloom-alpha: 0.09;
  }
  :global([data-theme="dark"]) .recursive-arc-bloom {
    --recursive-arc-bloom-rgb: 218, 218, 218;
    --recursive-arc-bloom-alpha: 0.12;
  }
  @media (prefers-reduced-motion: reduce) {
    .recursive-arc-bloom {
      opacity: 0.82;
    }
  }
</style>
