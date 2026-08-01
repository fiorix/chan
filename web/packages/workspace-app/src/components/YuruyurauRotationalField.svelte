<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    canvasCssValue,
    runCanvasAnimation,
  } from "./canvasAnimation";
  import {
    YURUYURAU_ROTATIONAL_SOURCE_SIZE,
    yuruyurauRotationalRasterScale,
  } from "./yuruyurauRotationalField";

  const SOURCE_SIZE = YURUYURAU_ROTATIONAL_SOURCE_SIZE;
  const SOURCE_CENTER = SOURCE_SIZE / 2;

  let {
    buildBasePoints,
    rotationCount,
    sourceTimePerMs,
    centerFadeRadius,
  }: {
    buildBasePoints: (sourceTime: number) => Float32Array;
    rotationCount: number;
    sourceTimePerMs: number;
    centerFadeRadius: number;
  } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = SOURCE_SIZE;
    sourceCanvas.height = SOURCE_SIZE;
    let sourceContext = sourceCanvas.getContext("2d");

    return runCanvasAnimation(host, (ctx) => {
      let width = 0;
      let height = 0;

      function drawCenterFade(backgroundColor: string): void {
        const centerX = width / 2;
        const centerY = height / 2;
        const innerRadius = Math.min(76, centerFadeRadius * 0.55);
        const gradient = ctx.createRadialGradient(
          centerX,
          centerY,
          innerRadius,
          centerX,
          centerY,
          centerFadeRadius,
        );
        gradient.addColorStop(0, `rgba(${backgroundColor}, 0.96)`);
        gradient.addColorStop(0.55, `rgba(${backgroundColor}, 0.82)`);
        gradient.addColorStop(1, `rgba(${backgroundColor}, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(
          centerX - centerFadeRadius,
          centerY - centerFadeRadius,
          centerFadeRadius * 2,
          centerFadeRadius * 2,
        );
      }

      function draw(sourceTime: number): void {
        if (width <= 0 || height <= 0) return;

        const backgroundColor = canvasCssValue(
          host,
          "--yuruyurau-background-rgb",
          "28, 28, 30",
        );
        const pointColor = canvasCssValue(
          host,
          "--yuruyurau-point-rgb",
          "218, 218, 218",
        );
        const pointAlpha = canvasCssNumber(
          host,
          "--yuruyurau-rotational-point-alpha",
          46 / 255,
        );
        const points = buildBasePoints(sourceTime);
        const coverScale = Math.max(width, height) / SOURCE_SIZE;
        const rasterScale = yuruyurauRotationalRasterScale(
          width,
          height,
          host.width / width,
        );
        const rasterSize = Math.ceil(SOURCE_SIZE * rasterScale);

        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${backgroundColor})`;
        ctx.fillRect(0, 0, width, height);

        const baseContext = sourceContext ?? sourceCanvas.getContext("2d");
        if (!baseContext) return;
        sourceContext = baseContext;
        if (
          sourceCanvas.width !== rasterSize ||
          sourceCanvas.height !== rasterSize
        ) {
          sourceCanvas.width = rasterSize;
          sourceCanvas.height = rasterSize;
        }
        baseContext.setTransform(rasterScale, 0, 0, rasterScale, 0, 0);
        baseContext.clearRect(0, 0, SOURCE_SIZE, SOURCE_SIZE);
        baseContext.beginPath();
        for (let index = 0; index < points.length; index += 2) {
          const x = points[index];
          const y = points[index + 1];
          if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < 0 ||
            x > SOURCE_SIZE ||
            y < 0 ||
            y > SOURCE_SIZE
          ) {
            continue;
          }
          baseContext.rect(x, y, 1, 1);
        }
        baseContext.globalAlpha = pointAlpha;
        baseContext.fillStyle = `rgb(${pointColor})`;
        baseContext.fill();
        baseContext.globalAlpha = 1;

        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.scale(coverScale, coverScale);
        for (let copy = 0; copy < rotationCount; copy += 1) {
          ctx.rotate((Math.PI * 2) / rotationCount);
          ctx.drawImage(
            sourceCanvas,
            0,
            0,
            rasterSize,
            rasterSize,
            -SOURCE_CENTER,
            -SOURCE_CENTER,
            SOURCE_SIZE,
            SOURCE_SIZE,
          );
        }
        ctx.restore();
        drawCenterFade(backgroundColor);
      }

      function drawAt(timeMs: number): void {
        draw(timeMs * sourceTimePerMs);
      }

      return {
        resize(nextWidth, nextHeight, reducedMotion, timeMs) {
          width = nextWidth;
          height = nextHeight;
          if (reducedMotion) draw(0);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(0),
      };
    });
  });
</script>

<div class="yuruyurau-rotational-field" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .yuruyurau-rotational-field {
    position: absolute;
    inset: 0;
    z-index: 0;
    --yuruyurau-background-rgb: 28, 28, 30;
    --yuruyurau-point-rgb: 218, 218, 218;
    --yuruyurau-rotational-point-alpha: 0.1804;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .yuruyurau-rotational-field {
    --yuruyurau-background-rgb: 255, 255, 255;
    --yuruyurau-point-rgb: 0, 0, 0;
    --yuruyurau-rotational-point-alpha: 0.14;
  }
  @media (prefers-reduced-motion: reduce) {
    .yuruyurau-rotational-field {
      opacity: 0.82;
    }
  }
</style>
