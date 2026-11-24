// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import Pane from "./Pane.svelte";
import { EXTENSION_CAPTURE_REQUEST } from "../state/extensionBridge";
import {
  captureViewFor,
  handleCaptureRequest,
  registerCapturePoster,
  resetExtensionCapture,
  startCaptureRecording,
} from "../state/extensionCapture.svelte";
import {
  cancelPaneMode,
  closeTab,
  layout,
  moveTab,
  type ExtensionTab,
  type LeafNode,
} from "../state/tabs.svelte";

const mounted: Array<Record<string, unknown>> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as typeof cancelAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as never;

const TAB: ExtensionTab = {
  kind: "extension",
  id: "ext-tab-1",
  title: "Echo",
  extensionId: "echo",
};

async function renderPane(): Promise<HTMLElement> {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-capture",
    tabs: [TAB],
    activeTabId: TAB.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const livePane = layout.nodes[pane.id];
  if (livePane?.kind !== "leaf") throw new Error("expected leaf");
  const component = mount(Pane, { target, props: { pane: livePane } });
  mounted.push(component as Record<string, unknown>);
  await tick();
  return target;
}

afterEach(async () => {
  for (const component of mounted.splice(0)) {
    await unmount(component as never);
  }
  document.body.innerHTML = "";
  resetExtensionCapture();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubMicrophone(): { stopped: boolean } {
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener() {},
  };
  const stream = { getTracks: () => [track] };
  vi.stubGlobal(
    "MediaRecorder",
    class extends EventTarget {
        static isTypeSupported(): boolean {
          return false;
        }
        state: RecordingState = "inactive";
        mimeType = "audio/webm";
        start(): void {
          this.state = "recording";
          this.dispatchEvent(new Event("start"));
        }
        stop(): void {
          this.state = "inactive";
        }
    },
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  resetExtensionCapture();
  registerCapturePoster(TAB.id, () => {});
  return track;
}

async function record(): Promise<void> {
  handleCaptureRequest(
    TAB.id,
    { extensionId: "echo", extensionName: "Echo", granted: true },
    {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "open",
      request_id: "request-1",
      source: "microphone",
    },
  );
  await startCaptureRecording(TAB.id);
  await tick();
}

describe("pane capture indicator", () => {
  test("a recording extension tab shows a labelled recording icon", async () => {
    stubMicrophone();
    const target = await renderPane();
    expect(target.querySelector('[aria-label="Echo: recording"]')).toBeNull();
    await record();
    expect(
      target.querySelector('[aria-label="Echo: recording"]'),
    ).not.toBeNull();
  });

  test("closing a recording tab through its pane releases the microphone", async () => {
    const track = stubMicrophone();
    const target = await renderPane();
    await record();
    await closeTab("pane-capture", TAB.id);
    await tick();
    await Promise.resolve();
    expect(target.querySelector("iframe")).toBeNull();
    expect(track.stopped).toBe(true);
    expect(captureViewFor(TAB.id)).toBeUndefined();
  });

  test("moving a recording tab to another pane keeps the microphone", async () => {
    const track = stubMicrophone();
    await renderPane();
    const other: LeafNode = {
      kind: "leaf",
      id: "pane-other",
      tabs: [],
      activeTabId: null,
    };
    layout.nodes[other.id] = other;
    const otherTarget = document.createElement("div");
    document.body.append(otherTarget);
    const liveOther = layout.nodes[other.id];
    if (liveOther?.kind !== "leaf") throw new Error("expected leaf");
    mounted.push(
      mount(Pane, { target: otherTarget, props: { pane: liveOther } }) as Record<string, unknown>,
    );
    await tick();
    await record();
    moveTab("pane-capture", TAB.id, other.id);
    await tick();
    await Promise.resolve();
    expect(track.stopped).toBe(false);
    expect(captureViewFor(TAB.id)?.phase).toBe("recording");
  });
});
