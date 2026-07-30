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
}

export interface CanvasAnimationOptions {
  frameRate?: number;
  maxDpr?: number;
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
      cleanup = animate(canvas, context, create, options);
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

function animate(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  create: (ctx: CanvasRenderingContext2D) => CanvasAnimationCallbacks,
  options: CanvasAnimationOptions,
): () => void {
  const callbacks = create(ctx);
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
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  };
}
