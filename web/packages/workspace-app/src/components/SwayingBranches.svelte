<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runCanvasAnimation } from "./canvasAnimation";
  import { buildSwayingBranches, SWAYING_BRANCHES_SOURCE_SIZE } from "./swayingBranches";

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function draw(timeMs: number): void {
        if (width <= 0 || height <= 0) return;
        const scale = Math.min(width, height) / SWAYING_BRANCHES_SOURCE_SIZE *
          canvasCssNumber(host, "--swaying-branches-field-scale", 1.05);
        const tone = canvasCssNumber(host, "--swaying-branches-tone", 0.68) * 255;
        const opacity = canvasCssNumber(host, "--swaying-branches-opacity", 0.32);
        const lines = buildSwayingBranches(0.01 + timeMs * 0.0003);
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.scale(scale, scale);
        ctx.strokeStyle = `rgb(${tone}, ${tone}, ${tone})`;
        ctx.globalAlpha = opacity;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const line of lines) {
          ctx.moveTo(line.x, line.y);
          ctx.lineTo(line.endX, line.endY);
        }
        ctx.stroke();
        ctx.restore();
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          draw(reducedMotion ? 2000 : timeMs);
        },
        frame: draw,
        reducedMotion: () => draw(2000),
      };
    });
  });
</script>

<div class="swaying-branches" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .swaying-branches {
    position: absolute;
    inset: 0;
    z-index: 0;
    --swaying-branches-field-scale: 1.05;
    --swaying-branches-tone: 0.68;
    --swaying-branches-opacity: 0.32;
    pointer-events: none;
    overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .swaying-branches {
    --swaying-branches-tone: 0;
    --swaying-branches-opacity: 0.25;
  }
  :global([data-theme="dark"]) .swaying-branches {
    --swaying-branches-tone: 0.68;
    --swaying-branches-opacity: 0.32;
  }
</style>
