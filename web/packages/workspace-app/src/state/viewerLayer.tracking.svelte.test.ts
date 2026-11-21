// @vitest-environment jsdom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { screensaver } from "./screensaver.svelte";
import { openSlidePreview } from "./slidePreview";

const SOURCE = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# One
`;

describe("a viewer updated from its host's effect under the lock", () => {
  const proto = HTMLElement.prototype as Partial<HTMLElement>;
  const originalRequest = proto.requestFullscreen;
  const requestFullscreen = vi.fn(async () => {});
  let lockRoot: HTMLElement | null = null;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    requestFullscreen.mockClear();
    Object.defineProperty(proto, "requestFullscreen", { configurable: true, value: requestFullscreen });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    lockRoot?.remove();
    lockRoot = null;
    screensaver.locked = false;
    flushSync();
    document.querySelectorAll(".md-slide-preview").forEach((node) => node.remove());
    if (originalRequest) Object.defineProperty(proto, "requestFullscreen", { configurable: true, value: originalRequest });
    else delete proto.requestFullscreen;
  });

  test("the effect does not rerun as the lock lifts, and fullscreen is asked for once", () => {
    const handle = openSlidePreview({ source: SOURCE, currentLine: 0, fromPath: "slides-test.md", theme: "dark", mode: "play" })!;
    let theme = $state<"dark" | "light">("dark");
    let runs = 0;
    stop = $effect.root(() => {
      $effect(() => {
        runs += 1;
        handle.update({ theme, mode: "play" });
      });
    });
    flushSync();
    expect(runs, "the host's first run").toBe(1);

    lockRoot = document.body.appendChild(document.createElement("div"));
    lockRoot.setAttribute("data-cover", "screensaver");
    lockRoot.style.position = "fixed";
    lockRoot.style.zIndex = "39000";
    screensaver.locked = true;
    flushSync();
    theme = "light";
    flushSync();
    expect(runs, "the update under the lock").toBe(2);

    requestFullscreen.mockClear();
    lockRoot.remove();
    lockRoot = null;
    screensaver.locked = false;
    flushSync();
    expect(runs, "the lift is not a dependency of the host").toBe(2);
    expect(requestFullscreen, "the lift asks once").toHaveBeenCalledTimes(1);
    handle.close({ notify: false });
  });
});
