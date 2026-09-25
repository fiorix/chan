// Drive a canvas animation component without a canvas. The runners in
// `components/canvasAnimation.ts` are swapped for recorders, so mounting a
// component records the animation it asks for (its runner, its options and
// its `create`) and schedules nothing; the test then creates the callbacks
// over a stand-in context and calls `resize`, `frame` and `reducedMotion`
// with the times it chooses. The runners' own scheduling is tested beside
// them in `canvasAnimation.test.ts`.
//
// A test file installs the recorders with its own hoisted mock:
//
//   vi.mock("./canvasAnimation", async (importOriginal) =>
//     (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
//   );

import { flushSync, mount, unmount, type Component } from "svelte";

import type * as CanvasAnimationModule from "../components/canvasAnimation";
import type {
  CanvasAnimationCallbacks,
  WebglAnimationOptions,
} from "../components/canvasAnimation";

/// One animation a component asked a runner for.
export interface AnimationRun {
  runner: "2d" | "webgl" | "webgl2";
  canvas: HTMLCanvasElement;
  create: (context: never) => CanvasAnimationCallbacks | null;
  options: WebglAnimationOptions;
}

const runs: AnimationRun[] = [];

/// `canvasAnimation` with its three runners replaced by recorders.
export function recordedRunners(
  actual: typeof CanvasAnimationModule,
): typeof CanvasAnimationModule {
  const record =
    (runner: AnimationRun["runner"]) =>
    (
      canvas: HTMLCanvasElement,
      create: AnimationRun["create"],
      options: WebglAnimationOptions = {},
    ): (() => void) => {
      runs.push({ runner, canvas, create, options });
      return () => {};
    };
  return {
    ...actual,
    runCanvasAnimation: record("2d"),
    runWebglAnimation: record("webgl"),
    runWebgl2Animation: record("webgl2"),
  } as typeof CanvasAnimationModule;
}

/// One thing a component did to a 2D context: a method call, or a property
/// write recorded as `set <name>`.
export interface CanvasOp {
  op: string;
  args: unknown[];
}

/// A stand-in 2D context that records every call and property write. Reads
/// return the last value written, or the canvas default.
export function recordingContext2d(): {
  ctx: CanvasRenderingContext2D;
  ops: CanvasOp[];
} {
  const ops: CanvasOp[] = [];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
  };
  const record =
    (op: string, result?: () => unknown) =>
    (...args: unknown[]): unknown => {
      ops.push({ op, args });
      return result?.();
    };
  const gradient = (): CanvasGradient =>
    ({ addColorStop: record("addColorStop") }) as unknown as CanvasGradient;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (key in state) return state[key];
      if (key === "createRadialGradient" || key === "createLinearGradient") {
        return record(key, gradient);
      }
      if (key === "measureText") return record(key, () => ({ width: 0 }));
      return record(key);
    },
    set(_target, key, value) {
      state[String(key)] = value;
      ops.push({ op: `set ${String(key)}`, args: [value] });
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

/// A stand-in WebGL2 context that records every call. Enums read back as
/// their own names (`gl.DYNAMIC_DRAW` is `"DYNAMIC_DRAW"`), every `create*`
/// returns a fresh object, a uniform location is `{ uniform: <name> }`, and
/// shaders and programs always compile and link. `overrides` answers named
/// calls instead, after recording them: `{ createProgram: () => null }` is a
/// driver that cannot link.
export function recordingWebgl2(
  overrides: Record<string, (...args: unknown[]) => unknown> = {},
): {
  gl: WebGL2RenderingContext;
  calls: CanvasOp[];
} {
  const calls: CanvasOp[] = [];
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
      if (key === "drawingBufferWidth" || key === "drawingBufferHeight") return 100;
      return (...args: unknown[]): unknown => {
        calls.push({ op: key, args });
        if (key in overrides) return overrides[key]!(...args);
        if (key.startsWith("create")) return { created: key };
        if (key === "getUniformLocation") return { uniform: args[1] };
        if (key === "getAttribLocation") return 0;
        if (key === "getShaderParameter" || key === "getProgramParameter") return true;
        if (key.endsWith("InfoLog")) return "";
        if (key === "isContextLost") return false;
        return undefined;
      };
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

const mounted: Array<() => void> = [];

/// Mount `component` and return the one animation it asked a runner for,
/// not yet created.
export function mountAnimation<Props extends Record<string, unknown>>(
  component: Component<Props>,
  props: Props = {} as Props,
): AnimationRun {
  runs.length = 0;
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(component, { target, props });
  flushSync();
  mounted.push(() => {
    unmount(instance);
    target.remove();
  });
  if (runs.length !== 1) {
    throw new Error(`expected one animation, the component started ${runs.length}`);
  }
  return runs[0]!;
}

/// Mount `component` and return the one animation it started, its callbacks
/// created over `context`.
export function startAnimation<Props extends Record<string, unknown>>(
  component: Component<Props>,
  context: unknown,
  props: Props = {} as Props,
): { run: AnimationRun; callbacks: CanvasAnimationCallbacks } {
  const run = mountAnimation(component, props);
  const callbacks = run.create(context as never);
  if (!callbacks) throw new Error("the animation declined to start");
  return { run, callbacks };
}

/// Unmount every component `mountAnimation` mounted.
export function stopAnimations(): void {
  for (const stop of mounted.splice(0)) stop();
  runs.length = 0;
}
