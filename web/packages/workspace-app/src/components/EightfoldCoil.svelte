<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    buildEightfoldCoilSpokes,
    createEightfoldCoilSegments,
    EIGHTFOLD_COIL_RUNS,
    EIGHTFOLD_COIL_SEGMENT_COUNT,
    EIGHTFOLD_COIL_SOURCE_SIZE,
  } from "./eightfoldCoil";
  import {
    createLineSegmentRenderer,
    LINE_SEGMENT_CONTEXT_ATTRIBUTES,
    type LineSegmentRenderer,
  } from "./lineSegments";

  // Half the pace of the video the loop was measured from.
  const LOOP_SECONDS_PER_SECOND = 0.5;
  // The still shown under reduced motion: two seconds into the loop, with
  // the four pairs of spokes at four stages of winding.
  const STATIC_SECONDS = 2;

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
            "[chan] Eightfold Coil WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        const segments = createEightfoldCoilSegments();

        function draw(seconds: number): void {
          renderer.draw({
            segments: buildEightfoldCoilSpokes(seconds, segments),
            segmentCount: EIGHTFOLD_COIL_SEGMENT_COUNT,
            runs: EIGHTFOLD_COIL_RUNS,
            sourceSize: EIGHTFOLD_COIL_SOURCE_SIZE,
            fieldScale: canvasCssNumber(
              host,
              "--eightfold-coil-field-scale",
              0.85,
            ),
            tone: canvasCssNumber(host, "--eightfold-coil-tone", 0.56),
            opacity: canvasCssNumber(
              host,
              "--eightfold-coil-opacity",
              0.335,
            ),
          });
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * LOOP_SECONDS_PER_SECOND);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_SECONDS);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_SECONDS),
          destroy: renderer.destroy,
        };
      },
      { contextAttributes: LINE_SEGMENT_CONTEXT_ATTRIBUTES },
    );
  });
</script>

<div class="eightfold-coil" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .eightfold-coil {
    position: absolute;
    inset: 0;
    z-index: 0;
    --eightfold-coil-field-scale: 0.85;
    --eightfold-coil-tone: 0.56;
    --eightfold-coil-opacity: 0.335;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .eightfold-coil {
    --eightfold-coil-tone: 0;
    --eightfold-coil-opacity: 0.3;
  }
  :global([data-theme="dark"]) .eightfold-coil {
    --eightfold-coil-tone: 0.56;
    --eightfold-coil-opacity: 0.335;
  }
  @media (prefers-reduced-motion: reduce) {
    .eightfold-coil {
      opacity: 0.84;
    }
  }
</style>
