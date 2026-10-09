<script lang="ts">
  import { onMount } from "svelte";
  import {
    BRANCHING_WREATH_SEGMENT_COUNT,
    BRANCHING_WREATH_SOURCE_SIZE,
    buildBranchingWreathSegments,
  } from "./branchingWreath";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createLineSegmentRenderer,
    LINE_SEGMENT_CONTEXT_ATTRIBUTES,
    LINE_SEGMENT_FLOATS,
    type LineSegmentRenderer,
  } from "./lineSegments";

  // The sketch advances its clock 0.003 radians per frame at 60 frames a
  // second; this runs at half that.
  const CLOCK_PER_SECOND = 0.09;
  const STATIC_TIME = 0;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: LineSegmentRenderer;
        try {
          renderer = createLineSegmentRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Branching Wreath WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        const segments = new Float32Array(
          BRANCHING_WREATH_SEGMENT_COUNT * LINE_SEGMENT_FLOATS,
        );

        function draw(time: number): void {
          renderer.draw({
            segments: buildBranchingWreathSegments(time, segments),
            segmentCount: BRANCHING_WREATH_SEGMENT_COUNT,
            sourceSize: BRANCHING_WREATH_SOURCE_SIZE,
            fieldScale: canvasCssNumber(
              host,
              "--branching-wreath-field-scale",
              1,
            ),
            tone: canvasCssNumber(
              host,
              "--branching-wreath-tone",
              0.54,
            ),
            opacity: canvasCssNumber(
              host,
              "--branching-wreath-opacity",
              0.3,
            ),
          });
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * CLOCK_PER_SECOND);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_TIME);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_TIME),
          destroy: renderer.destroy,
        };
      },
      { contextAttributes: LINE_SEGMENT_CONTEXT_ATTRIBUTES },
    );
  });
</script>

<div class="branching-wreath" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .branching-wreath {
    position: absolute;
    inset: 0;
    z-index: 0;
    --branching-wreath-field-scale: 1;
    --branching-wreath-tone: 0.54;
    --branching-wreath-opacity: 0.3;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .branching-wreath {
    --branching-wreath-tone: 0;
    --branching-wreath-opacity: 0.25;
  }
  :global([data-theme="dark"]) .branching-wreath {
    --branching-wreath-tone: 0.54;
    --branching-wreath-opacity: 0.3;
  }
  @media (prefers-reduced-motion: reduce) {
    .branching-wreath {
      opacity: 0.84;
    }
  }
</style>
