const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_FRAME_RATE = 24;
const DEFAULT_MAX_DPR = 2;

export interface CanvasAnimationCallbacks {
  resize(
    width: number,
    height: number,
    reducedMotion: boolean,
    timeMs: number,
  ): void;
  frame(timeMs: number): void;
  reducedMotion(): void;
  start?(): void;
  destroy?(): void;
}

export interface CanvasAnimationOptions {
  frameRate?: number;
  maxDpr?: number;
}

export interface WebglAnimationOptions extends CanvasAnimationOptions {
  maxPixels?: number;
  contextAttributes?: WebGLContextAttributes;
}

export function canvasCssValue(
  canvas: HTMLCanvasElement,
  name: string,
  fallback: string,
): string {
  const host = canvas.parentElement ?? canvas;
  return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
}

export function canvasCssNumber(
  canvas: HTMLCanvasElement,
  name: string,
  fallback: number,
): number {
  const raw = Number.parseFloat(canvasCssValue(canvas, name, String(fallback)));
  return Number.isFinite(raw) ? raw : fallback;
}

// Reads an "r, g, b" CSS variable (the format 2D canvas animations feed to
// rgb()) as normalized 0..1 channels for WebGL uniforms.
export function canvasCssRgb(
  canvas: HTMLCanvasElement,
  name: string,
  fallback: string,
): [number, number, number] {
  const channels = canvasCssValue(canvas, name, fallback).split(",");
  const rgb: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const channel = Number.parseFloat(channels[index] ?? "");
    rgb[index] = Number.isFinite(channel)
      ? Math.min(1, Math.max(0, channel / 255))
      : 0;
  }
  return rgb;
}

// WebKit can transiently return a null 2d context under canvas memory
// pressure (rapid animation switching re-mounts canvases faster than
// backing stores are reclaimed). One null must not leave the surface
// permanently blank, so probe again for a bounded window.
const CONTEXT_RETRY_FRAMES = 90;

export function runCanvasAnimation(
  canvas: HTMLCanvasElement,
  create: (ctx: CanvasRenderingContext2D) => CanvasAnimationCallbacks,
  options: CanvasAnimationOptions = {},
): () => void {
  let retryId: number | null = null;
  let cleanup: (() => void) | undefined;

  function attempt(remaining: number): void {
    retryId = null;
    const context = canvas.getContext("2d");
    if (context && typeof context.clearRect === "function") {
      cleanup = animate(
        canvas,
        create(context),
        options,
        (width, height, maxDpr) => {
          const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
        },
      );
      return;
    }
    if (remaining > 0) {
      retryId = requestAnimationFrame(() => attempt(remaining - 1));
    }
  }

  attempt(CONTEXT_RETRY_FRAMES);
  return () => {
    if (retryId !== null) cancelAnimationFrame(retryId);
    cleanup?.();
  };
}

export function runWebglAnimation(
  canvas: HTMLCanvasElement,
  create: (
    context: WebGLRenderingContext,
  ) => CanvasAnimationCallbacks | null,
  options: WebglAnimationOptions = {},
): () => void {
  return runGpuAnimation(canvas, "webgl", create, options);
}

export function runWebgl2Animation(
  canvas: HTMLCanvasElement,
  create: (
    context: WebGL2RenderingContext,
  ) => CanvasAnimationCallbacks | null,
  options: WebglAnimationOptions = {},
): () => void {
  return runGpuAnimation(canvas, "webgl2", create, options);
}

function runGpuAnimation<
  Context extends WebGLRenderingContext | WebGL2RenderingContext,
>(
  canvas: HTMLCanvasElement,
  contextName: "webgl" | "webgl2",
  create: (context: Context) => CanvasAnimationCallbacks | null,
  options: WebglAnimationOptions,
): () => void {
  let retryId: number | null = null;
  let cleanup: (() => void) | undefined;
  let stopped = false;
  const contextAttributes: WebGLContextAttributes = {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
    ...options.contextAttributes,
  };

  function attempt(remaining: number): void {
    retryId = null;
    if (stopped) return;
    const context = canvas.getContext(
      contextName,
      contextAttributes,
    ) as Context | null;
    if (context && typeof context.createShader === "function") {
      const callbacks = create(context);
      if (!callbacks) return;
      cleanup = animate(
        canvas,
        callbacks,
        { ...options, maxDpr: options.maxDpr ?? 1 },
        (width, height, maxDpr) => {
          const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
          const desiredWidth = Math.max(1, Math.floor(width * dpr));
          const desiredHeight = Math.max(1, Math.floor(height * dpr));
          const desiredPixels = desiredWidth * desiredHeight;
          const maxPixels = Math.max(
            1,
            options.maxPixels ?? desiredPixels,
          );
          const scale = Math.min(
            1,
            Math.sqrt(maxPixels / desiredPixels),
          );
          canvas.width = Math.max(1, Math.floor(desiredWidth * scale));
          canvas.height = Math.max(1, Math.floor(desiredHeight * scale));
          context.viewport(0, 0, canvas.width, canvas.height);
        },
      );
      return;
    }
    if (remaining > 0) {
      retryId = requestAnimationFrame(() => attempt(remaining - 1));
    }
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
    cleanup?.();
    cleanup = undefined;
  }

  function onContextRestored(): void {
    if (retryId !== null) cancelAnimationFrame(retryId);
    retryId = null;
    attempt(CONTEXT_RETRY_FRAMES);
  }

  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  attempt(CONTEXT_RETRY_FRAMES);

  return () => {
    stopped = true;
    if (retryId !== null) cancelAnimationFrame(retryId);
    cleanup?.();
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
  };
}

function animate(
  canvas: HTMLCanvasElement,
  callbacks: CanvasAnimationCallbacks,
  options: CanvasAnimationOptions,
  resizeBackingStore: (
    width: number,
    height: number,
    maxDpr: number,
  ) => void,
): () => void {
  const reduced = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  const frameIntervalMs = 1000 / (options.frameRate ?? DEFAULT_FRAME_RATE);
  const maxDpr = options.maxDpr ?? DEFAULT_MAX_DPR;
  let rafId: number | null = null;
  let lastDrawMs = 0;
  let inView = true;
  // Animations see a virtual clock: real elapsed time scaled by the
  // host's --canvas-animation-speed variable. Frame pacing stays
  // wall-clock; only the time handed to callbacks stretches, so every
  // animation gets a speed control with no per-component wiring.
  let virtualMs = 0;

  function stop(): void {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function loop(timeMs: number): void {
    if (timeMs - lastDrawMs >= frameIntervalMs) {
      const speed = canvasCssNumber(
        canvas,
        "--canvas-animation-speed",
        1,
      );
      virtualMs +=
        (lastDrawMs === 0 ? frameIntervalMs : timeMs - lastDrawMs) *
        speed;
      callbacks.frame(virtualMs);
      lastDrawMs = timeMs;
    }
    rafId = requestAnimationFrame(loop);
  }

  function start(): void {
    stop();
    if (document.hidden || !inView) return;
    if (reduced?.matches) {
      callbacks.reducedMotion();
      return;
    }
    callbacks.start?.();
    lastDrawMs = 0;
    rafId = requestAnimationFrame(loop);
  }

  function resize(): void {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    resizeBackingStore(width, height, maxDpr);
    callbacks.resize(
      width,
      height,
      reduced?.matches ?? false,
      virtualMs,
    );
  }

  function onVisibilityChange(): void {
    if (document.hidden) stop();
    else start();
  }

  const observer =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  // A canvas that is not on screen (hidden tab side, collapsed or
  // scrolled-out pane, display:none) must cost zero CPU: no frames,
  // no simulation stepping.
  const intersection =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          const last = entries[entries.length - 1];
          if (!last || last.isIntersecting === inView) return;
          inView = last.isIntersecting;
          if (inView) start();
          else stop();
        })
      : null;
  intersection?.observe(canvas);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  reduced?.addEventListener?.("change", start);

  resize();
  start();

  return () => {
    stop();
    observer?.disconnect();
    intersection?.disconnect();
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    reduced?.removeEventListener?.("change", start);
    callbacks.destroy?.();
  };
}
