import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const script = readFileSync("../../../desktop/src-tauri/src/launcher_transition.js", "utf8");
type Stages = Record<string, (startAt?: number) => unknown>;
const runtime = window as unknown as { __chanLauncherTransition?: Stages };
let root: HTMLElement;
let animations: { cancel: ReturnType<typeof vi.fn>; currentTime: number }[];

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app"></div>';
  document.body.style.background = "rgb(20, 30, 40)";
  root = document.getElementById("app")!;
  animations = [];
  delete runtime.__chanLauncherTransition;
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  root.animate = vi.fn(() => {
    const animation = { cancel: vi.fn(), currentTime: 0, finished: new Promise(() => {}) };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  new Function(script)();
});

afterEach(() => {
  runtime.__chanLauncherTransition?.hostReset();
  delete runtime.__chanLauncherTransition;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

function stage(name: string, at?: number) { return runtime.__chanLauncherTransition![name](at); }

describe("Computers carousel", () => {
  test("reads the host focus colour and forwards only colour changes", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    let changed: () => void = () => {};
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { changed = callback; }
      observe() {}
    });
    document.documentElement.style.setProperty("--pane-highlight-color", "#22C55E");
    try {
      expect(stage("hostFocusColor")).toBe("#22c55e");
      changed();
      expect(invoke).not.toHaveBeenCalled();
      document.documentElement.style.setProperty("--pane-highlight-color", "#ff5fb7");
      changed();
      expect(invoke).toHaveBeenCalledWith("set_launcher_focus_color", { color: "#ff5fb7" });
      document.documentElement.style.setProperty("--pane-highlight-color", "not-a-colour");
      changed();
      expect(invoke).toHaveBeenCalledOnce();
      document.documentElement.style.removeProperty("--pane-highlight-color");
      document.documentElement.style.setProperty("--pane-focus", "#7aa6e0");
      expect(stage("hostFocusColor")).toBe("#7aa6e0");
    } finally {
      document.documentElement.removeAttribute("style");
    }
  });

  test("native settlement explicitly resumes the background and suspension pauses it", () => {
    const notify = vi.fn();
    window.addEventListener("chan-launcher-settled", notify);
    try {
      stage("launcherSuspended");
      expect((window as unknown as { __chanLauncherSettled: boolean }).__chanLauncherSettled).toBe(false);
      stage("launcherPrimeIn");
      stage("launcherIn");
      vi.advanceTimersByTime(320);
      expect(notify).toHaveBeenCalledOnce();
      stage("launcherShown");
      expect((window as unknown as { __chanLauncherSettled: boolean }).__chanLauncherSettled).toBe(true);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("chan-launcher-settled", notify);
      delete (window as unknown as { __chanLauncherSettled?: boolean }).__chanLauncherSettled;
    }
  });

  test("show pushes the host right and brings Computers from the left; hide reverses it", () => {
    for (const [name, from, to] of [
      ["hostOut", 0, 100], ["launcherIn", -100, 0],
      ["hostIn", 100, 0], ["launcherOut", 0, -100],
    ] as const) {
      stage("hostReset");
      stage(name);
      expect(root.animate).toHaveBeenLastCalledWith(
        [{ transform: `translate3d(${from}vw, 0, 0)` }, { transform: `translate3d(${to}vw, 0, 0)` }],
        expect.objectContaining({ duration: 320, fill: "both" }),
      );
      expect(root.style.opacity).toBe("");
    }
  });

  test("a primed launcher covers only its moving card and restores backgrounds at rest", () => {
    stage("launcherPrimeIn");
    expect(root.style.transform).toBe("translate3d(-100vw, 0, 0)");
    expect(document.body.style.background).toBe("transparent");
    expect(root.style.backgroundColor).toBe("rgb(20, 30, 40)");
    new Function(script)();
    stage("launcherIn");
    vi.advanceTimersByTime(320);
    expect(document.body.style.background).toBe("rgb(20, 30, 40)");
    expect(root.style.cssText).toBe("");
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("interrupted animations restore original inline styles and priorities", () => {
    root.style.setProperty("transform", "translateY(2px)", "important");
    root.style.setProperty("pointer-events", "auto", "important");
    stage("hostOut");
    stage("hostPrimeIn");
    stage("hostIn");
    stage("hostReset");
    vi.advanceTimersByTime(1000);
    expect(root.style.transform).toBe("translateY(2px)");
    expect(root.style.getPropertyPriority("transform")).toBe("important");
    expect(root.style.pointerEvents).toBe("auto");
    expect(animations.every((a) => a.cancel.mock.calls.length > 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("both webviews use the shared clock and a delayed script catches up", () => {
    const startAt = Date.now() + 40;
    stage("hostOut", startAt);
    expect(root.animate).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ delay: 40 }));
    stage("hostReset");
    vi.advanceTimersByTime(60);
    stage("launcherIn", startAt);
    expect(animations[1].currentTime).toBe(20);
  });

  test("reduced motion does not prime or animate either page", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(stage("motionEnabled")).toBe(false);
    for (const name of ["hostPrimeOut", "hostOut", "hostPrimeIn", "hostIn", "launcherPrimeIn", "launcherIn", "launcherPrimeOut", "launcherOut"]) stage(name);
    expect(root.style.cssText).toBe("");
    expect(document.body.style.background).toBe("rgb(20, 30, 40)");
    expect(root.animate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
