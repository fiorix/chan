<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createNinefoldLotusRenderer,
    type NinefoldLotusRenderer,
  } from "./ninefoldLotus";

  // The sketch runs at 60 frames a second; this runs at half that.
  const SOURCE_FRAMES_PER_SECOND = 30;
  // The source frames one paint runs, so a stall is not replayed.
  const MAX_FRAMES_PER_PAINT = 6;
  // The still shown under reduced motion: the picture at this source frame,
  // with the glow the frames before it would have left.
  const STATIC_FRAME = 230;
  const STATIC_FRAMES = 48;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: NinefoldLotusRenderer;
        try {
          renderer = createNinefoldLotusRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Ninefold Lotus WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        let lastFrame: number | null = null;

        function paint(frames: readonly number[]): void {
          renderer.draw({
            frames,
            fieldScale: canvasCssNumber(
              host,
              "--ninefold-lotus-field-scale",
              1.05,
            ),
            tone: canvasCssNumber(host, "--ninefold-lotus-tone", 0.415),
            opacity: canvasCssNumber(
              host,
              "--ninefold-lotus-opacity",
              0.505,
            ),
          });
        }

        function drawAt(timeMs: number): void {
          const frame = Math.floor(
            timeMs * 0.001 * SOURCE_FRAMES_PER_SECOND,
          );
          const first =
            lastFrame === null
              ? frame
              : Math.max(lastFrame + 1, frame - MAX_FRAMES_PER_PAINT + 1);
          lastFrame = frame;

          const frames: number[] = [];
          for (let next = first; next <= frame; next += 1) frames.push(next);
          // Between two source frames the canvas already shows the picture.
          if (frames.length > 0) paint(frames);
        }

        function drawStatic(): void {
          renderer.reset();
          const frames: number[] = [];
          for (let back = STATIC_FRAMES - 1; back >= 0; back -= 1) {
            frames.push(STATIC_FRAME - back);
          }
          paint(frames);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            lastFrame = null;
            if (reducedMotion) {
              drawStatic();
            } else {
              renderer.reset();
              drawAt(timeMs);
            }
          },
          frame: drawAt,
          reducedMotion: drawStatic,
          start: () => {
            lastFrame = null;
          },
          destroy: renderer.destroy,
        };
      },
      // The dots are a couple of pixels across, so they are drawn at the
      // display's density; the glow under them is kept much smaller.
      { maxDpr: 2 },
    );
  });
</script>

<div class="ninefold-lotus" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .ninefold-lotus {
    position: absolute;
    inset: 0;
    z-index: 0;
    --ninefold-lotus-field-scale: 1.05;
    --ninefold-lotus-tone: 0.415;
    --ninefold-lotus-opacity: 0.505;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .ninefold-lotus {
    --ninefold-lotus-tone: 0;
    --ninefold-lotus-opacity: 0.6;
  }
  :global([data-theme="dark"]) .ninefold-lotus {
    --ninefold-lotus-tone: 0.415;
    --ninefold-lotus-opacity: 0.505;
  }
  @media (prefers-reduced-motion: reduce) {
    .ninefold-lotus {
      opacity: 0.84;
    }
  }
</style>
