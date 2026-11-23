// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => false,
}));

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { EXTENSION_CAPTURE_REQUEST } from "./state/extensionBridge";
import {
  handleCaptureRequest,
  registerCapturePoster,
  resetExtensionCapture,
} from "./state/extensionCapture.svelte";

stubAppEnvironment();

beforeEach(async () => {
  resetExtensionCapture();
  await mountApp();
  await settle();
});

afterEach(async () => {
  resetExtensionCapture();
  await unmountApp();
});

describe("capture page-close guard", () => {
  test("a live capture session holds the page open in a plain browser", async () => {
    const idle = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    vi.stubGlobal(
      "MediaRecorder",
      class extends EventTarget {
        state: RecordingState = "inactive";
        mimeType = "audio/webm";
        start(): void {
          this.state = "recording";
        }
        stop(): void {
          this.state = "inactive";
        }
      },
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    registerCapturePoster("tab-capture", () => {});
    handleCaptureRequest(
      "tab-capture",
      { extensionId: "echo", extensionName: "Echo", granted: true },
      {
        type: EXTENSION_CAPTURE_REQUEST,
        action: "open",
        request_id: "request-1",
        source: "microphone",
      },
    );
    const guarded = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);
  });
});
