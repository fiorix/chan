<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runCanvasAnimation } from "./canvasAnimation";
  import { buildContractingSpiral, contractingSpiralState, CONTRACTING_SPIRAL_SOURCE_SIZE } from "./contractingSpiral";

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(timeMs: number): void {
        if (width <= 0 || height <= 0) return;
        const scale = Math.min(width, height) / CONTRACTING_SPIRAL_SOURCE_SIZE *
          canvasCssNumber(host, "--contracting-spiral-field-scale", 1);
        const tone = canvasCssNumber(host, "--contracting-spiral-tone", 0.7) * 255;
        const opacity = canvasCssNumber(host, "--contracting-spiral-opacity", 0.35);
        const state = contractingSpiralState(timeMs * 0.06);
        const circles = buildContractingSpiral(state.contraction);
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.scale(scale, scale);
        ctx.strokeStyle = `rgb(${tone}, ${tone}, ${tone})`;
        ctx.globalAlpha = opacity * state.alpha;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const circle of circles) {
          ctx.moveTo(circle.x + circle.radius, circle.y);
          ctx.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
        }
        ctx.stroke();
        ctx.restore();
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          draw(reducedMotion ? 15000 : timeMs);
        },
        frame: draw,
        reducedMotion: () => draw(15000),
      };
    });
  });
</script>

<div class="contracting-spiral" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .contracting-spiral {
    position: absolute;
    inset: 0;
    z-index: 0;
    --contracting-spiral-field-scale: 1;
    --contracting-spiral-tone: 0.7;
    --contracting-spiral-opacity: 0.35;
    pointer-events: none;
    overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .contracting-spiral {
    --contracting-spiral-tone: 0;
    --contracting-spiral-opacity: 0.3;
  }
  :global([data-theme="dark"]) .contracting-spiral {
    --contracting-spiral-tone: 0.7;
    --contracting-spiral-opacity: 0.35;
  }
</style>
