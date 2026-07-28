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

export function runCanvasAnimation(
  canvas: HTMLCanvasElement,
  create: (ctx: CanvasRenderingContext2D) => CanvasAnimationCallbacks,
  options: CanvasAnimationOptions = {},
): (() => void) | undefined {
  const context = canvas.getContext("2d");
  if (!context || typeof context.clearRect !== "function") return;
  const ctx = context;

  const callbacks = create(ctx);
  const reduced = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  const frameIntervalMs = 1000 / (options.frameRate ?? DEFAULT_FRAME_RATE);
  const maxDpr = options.maxDpr ?? DEFAULT_MAX_DPR;
  let rafId: number | null = null;
  let lastDrawMs = 0;

  function stop(): void {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function loop(timeMs: number): void {
    if (timeMs - lastDrawMs >= frameIntervalMs) {
      callbacks.frame(timeMs);
      lastDrawMs = timeMs;
    }
    rafId = requestAnimationFrame(loop);
  }

  function start(): void {
    stop();
    if (document.hidden) return;
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
      performance.now(),
    );
  }

  function onVisibilityChange(): void {
    if (document.hidden) stop();
    else start();
  }

  const observer =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  reduced?.addEventListener?.("change", start);

  resize();
  start();

  return () => {
    stop();
    observer?.disconnect();
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    reduced?.removeEventListener?.("change", start);
  };
}
