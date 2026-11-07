import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// chan-desktop evaluates this script in every webview of a window that comes
// back into view, so its web process commits a frame.
const script = readFileSync("../../../desktop/src-tauri/src/wake_repaint.js", "utf8");
let frames: FrameRequestCallback[];

function repaint(): void {
  new Function(script)();
}

function renderFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
}

function probes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#chan-wake-repaint")];
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  document.documentElement.setAttribute("data-theme", "dark");
  document.body.innerHTML =
    '<div id="app"><div class="pane focused"><div class="terminal-host" style="width: 800px; height: 600px"></div></div></div>';
});

afterEach(() => {
  for (const probe of probes()) probe.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Each test starts from a page no earlier repaint touched.
  for (const element of [document.documentElement, document.body]) {
    for (const { name } of [...element.attributes]) element.removeAttribute(name);
  }
  document.body.innerHTML = "";
});

describe("the repaint chan-desktop runs when a window comes back into view", () => {
  test("renders one frame with an inert one-pixel element, then removes it", () => {
    const page = document.documentElement.outerHTML;
    repaint();

    const [probe] = probes();
    expect(probe?.parentElement).toBe(document.documentElement);
    expect(probe.getAttribute("aria-hidden")).toBe("true");
    const { position, left, top, width, height, opacity, pointerEvents } = probe.style;
    expect({ position, left, top, width, height, opacity, pointerEvents }).toEqual({
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });

    renderFrame();
    expect(probes(), "the frame that renders it keeps it").toHaveLength(1);
    renderFrame();
    expect(probes()).toHaveLength(0);
    expect(document.documentElement.outerHTML).toBe(page);
  });

  test("leaves every element of the page as it was while it shows", () => {
    const root = [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`);
    const body = document.body.outerHTML;
    repaint();
    expect([...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`)).toEqual(root);
    expect(document.body.outerHTML).toBe(body);
    expect(document.documentElement.lastElementChild?.id).toBe("chan-wake-repaint");
  });

  test("a page that renders no frames drops the element after a second", () => {
    repaint();
    vi.advanceTimersByTime(999);
    expect(probes()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(probes()).toHaveLength(0);
  });

  test("a second repaint before the first is done keeps one element", () => {
    repaint();
    repaint();
    expect(probes()).toHaveLength(1);
    renderFrame();
    renderFrame();
    expect(probes()).toHaveLength(0);
  });
});
