/// The frame-rate instrument for the canvas animation family.
///
/// WHY it exists: `canvas-animations-are-software-rasterized-on-linux` closed
/// its vortex and bloom arms on "60 fps on AMD Radeon 780M through ANGLE" and
/// left the point cloud host unmeasured. Neither reading has an instrument
/// behind it, so the vortex number cannot be reproduced and the point cloud
/// number would be a second anecdote next to the first. This runs both on one
/// machine, in one pass, against one clock.
///
/// WHY the siblings are in the run: they are the control. An instrument that
/// reads low for everything is indistinguishable from a slow point cloud
/// unless something already known to be fast is measured beside it. The
/// vortex and the two blooms are that something.
///
/// WHY a baseline arm with nothing mounted: "60 fps" is a claim about the
/// animation, and an observer can only ever see min(display rate, animation
/// rate). On a 60Hz panel a perfect animation and a 200Hz-capable one both
/// read 60. Measuring the empty page first establishes what the display can
/// do, so every arm below it is read as a distance from that, not as an
/// absolute.
///
/// WHAT it measures: the interval between successive frames on the main
/// thread, observed from a requestAnimationFrame loop running alongside the
/// animation. The animation draws inside its own rAF callback
/// (`runGpuAnimation` in canvasAnimation.ts), so a draw that costs 40ms
/// blocks the thread and stretches the observed interval to 40ms. That is the
/// quantity the original defect changed: 30k `ctx.rect()` calls per frame is
/// expensive because it is slow on the thread, not because it is queued.
///
/// The components are the product's own, imported and mounted, not
/// reimplemented. Three different wirings (the point cloud host, the
/// rotational field, the vortex's particle system) would be three chances to
/// measure a copy instead of the thing.

import { mount, unmount } from "svelte";

import FourteenfoldBloom from "@components/FourteenfoldBloom.svelte";
import HexagonalBloom from "@components/HexagonalBloom.svelte";
import LorenzConstellation from "@components/LorenzConstellation.svelte";
import RippledDuet from "@components/RippledDuet.svelte";
import SixfoldVortex from "@components/SixfoldVortex.svelte";
import StriatedCurrent from "@components/StriatedCurrent.svelte";
import TwinVeilDance from "@components/TwinVeilDance.svelte";

/// The acceptance bar the item states: "hold 60 fps". Read against a
/// tolerance rather than exactly, because a rAF loop sharing a thread with a
/// compositor never reports a clean 60.000.
const TARGET_FPS = 55;

/// Long enough for the shader compile, the first buffer upload and any
/// driver-side warm-up to land outside the window that gets measured.
const WARMUP_MS = 1500;
const MEASURE_MS = 5000;

type Arm = {
  id: string;
  name: string;
  component: unknown | null;
  family: string;
};

/// Baseline first: everything after it is read against what it establishes.
/// Then the three siblings whose numbers are already recorded, then the four
/// the point cloud hosts, which are what this run exists to measure.
const ARMS: Arm[] = [
  { id: "baseline", name: "baseline (nothing mounted)", component: null, family: "control" },
  { id: "sixfold-vortex", name: "Sixfold Vortex", component: SixfoldVortex, family: "sibling" },
  { id: "hexagonal-bloom", name: "Hexagonal Bloom", component: HexagonalBloom, family: "sibling" },
  { id: "fourteenfold-bloom", name: "Fourteenfold Bloom", component: FourteenfoldBloom, family: "sibling" },
  { id: "lorenz-constellation", name: "Lorenz Constellation", component: LorenzConstellation, family: "point-cloud" },
  { id: "rippled-duet", name: "Rippled Duet", component: RippledDuet, family: "point-cloud" },
  { id: "striated-current", name: "Striated Current", component: StriatedCurrent, family: "point-cloud" },
  { id: "twin-veil-dance", name: "Twin Veil Dance", component: TwinVeilDance, family: "point-cloud" },
];

type Result = {
  id: string;
  name: string;
  family: string;
  frames: number;
  fps: number;
  medianMs: number;
  p95Ms: number;
  worstMs: number;
  drawingBuffer: string | null;
  warnings: string[];
};

/// Every `[chan]` warning the components emit, per arm. The point of catching
/// them: `runGpuAnimation` returns early when the renderer cannot be created,
/// and the component logs and gives up. A dead animation costs nothing per
/// frame, so it reads as a PERFECT frame rate. Without this, the one failure
/// mode that matters most would present itself as the best possible result.
let armWarnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const text = args
    .map((a) => (a instanceof Error ? a.message : String(a)))
    .join(" ");
  if (text.includes("[chan]")) armWarnings.push(text);
  realWarn(...args);
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[index];
}

/// Collect inter-frame intervals for `ms`, then stop. Nothing is drawn here;
/// the loop only timestamps, so what it adds to the thread is negligible
/// against what the animation is doing.
function observe(ms: number): Promise<number[]> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = performance.now();
    const until = last + ms;
    function tick(now: number) {
      intervals.push(now - last);
      last = now;
      if (now < until) requestAnimationFrame(tick);
      else resolve(intervals);
    }
    requestAnimationFrame(tick);
  });
}

async function runArm(arm: Arm, host: HTMLElement): Promise<Result> {
  armWarnings = [];
  const instance = arm.component
    ? mount(arm.component as never, { target: host })
    : null;

  await sleep(WARMUP_MS);

  const canvas = host.querySelector("canvas");
  // The drawing buffer's size is the second half of the dead-animation guard:
  // a canvas that never got a context, or got one at 0x0, is not drawing
  // whatever the frame rate says.
  const drawingBuffer = canvas ? `${canvas.width}x${canvas.height}` : null;

  const intervals = await observe(MEASURE_MS);

  if (instance) unmount(instance);
  host.replaceChildren();

  const sorted = [...intervals].sort((a, b) => a - b);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  return {
    id: arm.id,
    name: arm.name,
    family: arm.family,
    frames: intervals.length,
    fps: total > 0 ? (intervals.length / total) * 1000 : 0,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    worstMs: sorted.length ? sorted[sorted.length - 1] : 0,
    drawingBuffer,
    warnings: [...armWarnings],
  };
}

function verdict(results: Result[]): { code: number; line: string } {
  const baseline = results.find((r) => r.id === "baseline");
  if (!baseline) return { code: 2, line: "INCONCLUSIVE: no baseline arm ran" };

  if (baseline.fps < TARGET_FPS) {
    return {
      code: 2,
      line:
        `INCONCLUSIVE: the empty page only reaches ${baseline.fps.toFixed(1)} fps,` +
        ` so this display or host cannot present 60 and no arm below can be` +
        ` read as an animation's cost.`,
    };
  }

  const dead = results.filter(
    (r) =>
      r.id !== "baseline" &&
      (r.warnings.length > 0 ||
        !r.drawingBuffer ||
        r.drawingBuffer.startsWith("0x")),
  );
  if (dead.length) {
    return {
      code: 2,
      line:
        `INCONCLUSIVE: ${dead.map((d) => d.name).join(", ")} did not start a` +
        ` renderer. A dead animation costs nothing per frame and reads as a` +
        ` perfect frame rate, so these numbers mean nothing.`,
    };
  }

  const slow = results.filter(
    (r) => r.id !== "baseline" && r.fps < TARGET_FPS,
  );
  if (slow.length) {
    return {
      code: 1,
      line:
        `FAIL: ${slow
          .map((s) => `${s.name} at ${s.fps.toFixed(1)} fps`)
          .join(", ")} — below the ${TARGET_FPS} fps bar.`,
    };
  }
  return {
    code: 0,
    line: `PASS: every arm holds ${TARGET_FPS}+ fps against a ${baseline.fps.toFixed(1)} fps baseline.`,
  };
}

function render(results: Result[], done: boolean, line: string): void {
  const rows = results
    .map(
      (r) => `<tr class="${r.family}">
        <td>${r.name}</td>
        <td class="n">${r.fps.toFixed(1)}</td>
        <td class="n">${r.medianMs.toFixed(1)}</td>
        <td class="n">${r.p95Ms.toFixed(1)}</td>
        <td class="n">${r.worstMs.toFixed(1)}</td>
        <td class="n">${r.frames}</td>
        <td>${r.drawingBuffer ?? "—"}</td>
        <td class="warn">${r.warnings.join("; ")}</td>
      </tr>`,
    )
    .join("");
  document.getElementById("out")!.innerHTML = `
    <table>
      <thead><tr>
        <th>arm</th><th>fps</th><th>median ms</th><th>p95 ms</th>
        <th>worst ms</th><th>frames</th><th>drawing buffer</th><th>warnings</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="verdict">${done ? line : "measuring…"}</p>
    <p class="env">${navigator.userAgent}<br>devicePixelRatio ${window.devicePixelRatio}</p>`;
}

async function main() {
  const host = document.getElementById("stage")!;
  const results: Result[] = [];
  render(results, false, "");
  for (const arm of ARMS) {
    document.getElementById("now")!.textContent = `running: ${arm.name}`;
    results.push(await runArm(arm, host));
    render(results, false, "");
  }
  document.getElementById("now")!.textContent = "";
  const outcome = verdict(results);
  render(results, true, outcome.line);
  // The driver reads this; a human reads the table above it. Both see the
  // same numbers because both come from the same array.
  document.title = `animation-fps ${JSON.stringify({
    code: outcome.code,
    line: outcome.line,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    results,
  })}`;
}

main().catch((err) => {
  document.title = `animation-fps-error ${err?.message ?? err}`;
  document.getElementById("out")!.textContent = `error: ${err?.message ?? err}`;
});
