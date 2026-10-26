import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import PlasmaBackground from "./PlasmaBackground.svelte";
import { createPlasmaBackground, hasBackgroundGpu } from "../lib/plasmaBackground";

vi.mock("../lib/plasmaBackground", () => ({ DEFAULT_WAVE_SPEED: 0.5, createPlasmaBackground: vi.fn(), hasBackgroundGpu: vi.fn() }));

let app: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let motion: EventTarget & { matches: boolean };
const wave = { start: vi.fn(), stop: vi.fn(), clear: vi.fn(), destroy: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  target = document.createElement("div");
  document.body.append(target);
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => motion);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(hasBackgroundGpu).mockReturnValue(true);
  vi.mocked(createPlasmaBackground).mockReturnValue(wave);
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
  delete window.__chanLauncherSettled;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render() {
  app = mount(PlasmaBackground, { target });
  flushSync();
}
function settled(value: boolean) {
  window.__chanLauncherSettled = value;
  window.dispatchEvent(new Event("chan-launcher-settled"));
}

describe("launcher wave lifecycle", () => {
  it("allocates nothing until the native carousel has settled; suspends on hide", () => {
    window.__chanLauncherSettled = false;
    render();
    expect(createPlasmaBackground).not.toHaveBeenCalled();
    expect(hasBackgroundGpu).not.toHaveBeenCalled();
    settled(true);
    expect(wave.start).toHaveBeenCalledOnce();
    settled(false);
    expect(wave.stop).toHaveBeenCalledOnce();
    settled(true);
    expect(createPlasmaBackground).toHaveBeenCalledOnce();
    expect(wave.start).toHaveBeenCalledTimes(2);
  });

  it("starts on a standalone page and stops while the document is hidden", async () => {
    render();
    expect(wave.start).toHaveBeenCalledOnce();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wave.stop).toHaveBeenCalledOnce();
    await unmount(app!);
    app = undefined;
    expect(wave.destroy).toHaveBeenCalledOnce();
    const calls = wave.start.mock.calls.length;
    settled(true);
    expect(wave.start).toHaveBeenCalledTimes(calls);
  });

  it("skips reduced motion and clears an existing wave when the preference changes", () => {
    motion.matches = true;
    render();
    expect(hasBackgroundGpu).not.toHaveBeenCalled();
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(wave.start).toHaveBeenCalledOnce();
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(wave.stop).toHaveBeenCalledOnce();
    expect(wave.clear).toHaveBeenCalledOnce();
  });

  it("never allocates a drawing canvas without a GPU", () => {
    vi.mocked(hasBackgroundGpu).mockReturnValue(false);
    render();
    expect(createPlasmaBackground).not.toHaveBeenCalled();
    expect(wave.start).not.toHaveBeenCalled();
  });
});
