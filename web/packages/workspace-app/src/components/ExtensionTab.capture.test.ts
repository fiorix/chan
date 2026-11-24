// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import type { ExtensionInfo } from "../api/types";
import { commandById } from "../state/commands";
import {
  EXTENSION_CAPTURE_EVENT,
  EXTENSION_CAPTURE_REQUEST,
  EXTENSION_CAPTURE_SOURCES_MESSAGE,
} from "../state/extensionBridge";
import {
  captureViewFor,
  resetExtensionCapture,
} from "../state/extensionCapture.svelte";
import { refreshExtensions } from "../state/extensions.svelte";
import { resetLayout } from "../__tests__/tabs";
import {
  activePane,
  closeTab,
  type ExtensionTab as ExtensionTabState,
} from "../state/tabs.svelte";
import ExtensionTab from "./ExtensionTab.svelte";

const ENTRY: ExtensionInfo = {
  id: "echo",
  name: "Echo",
  entry_path: `/_chan/extensions/echo/${"a".repeat(64)}/`,
  singleton: true,
  running: true,
  capabilities: ["microphone"],
};

class FakeTrack extends EventTarget {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(): boolean {
    return false;
  }
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  constructor(readonly stream: unknown) {
    super();
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = "recording";
    this.dispatchEvent(new Event("start"));
  }
  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  }
  data(blob: Blob): void {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
  }
}

let view: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;
let track: FakeTrack;
let getUserMedia: ReturnType<typeof vi.fn>;
let catalog: ReturnType<typeof vi.spyOn>;

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await Promise.resolve();
}

async function show(
  entry: ExtensionInfo = ENTRY,
): Promise<{ frame: HTMLIFrameElement; tab: ExtensionTabState }> {
  resetLayout([]);
  resetExtensionCapture();
  catalog = vi.spyOn(api, "extensions").mockResolvedValue([entry]);
  await refreshExtensions();
  commandById("extension.echo")!.run();
  const opened = activePane().tabs[0];
  if (opened?.kind !== "extension") throw new Error("expected an extension tab");
  const tab = opened as ExtensionTabState;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ExtensionTab, {
    target,
    props: { tab, paneId: activePane().id },
  });
  await settle();
  const frame = target.querySelector("iframe");
  if (!frame) throw new Error("expected an extension iframe");
  return { frame, tab };
}

async function remount(tab: ExtensionTabState): Promise<HTMLIFrameElement> {
  if (view) await unmount(view);
  view = null;
  target?.remove();
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ExtensionTab, {
    target,
    props: { tab, paneId: activePane().id },
  });
  await settle();
  const frame = target.querySelector("iframe");
  if (!frame) throw new Error("expected an extension iframe");
  return frame;
}

function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", { source: frame.contentWindow, data }),
  );
}

function openCapture(frame: HTMLIFrameElement, id = "request-1"): void {
  fromFrame(frame, {
    type: EXTENSION_CAPTURE_REQUEST,
    request_id: id,
    action: "open",
    source: "microphone",
  });
}

function clickButton(text: string): void {
  const button = [...(target?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`expected a ${text} button`);
  (button as HTMLButtonElement).click();
}

function watchPosts(frame: HTMLIFrameElement): Array<Record<string, unknown>> {
  const posted: Array<Record<string, unknown>> = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(
    (message: unknown) => {
      posted.push(message as Record<string, unknown>);
    },
  );
  return posted;
}

async function startRecording(frame: HTMLIFrameElement): Promise<void> {
  openCapture(frame);
  await settle();
  clickButton("Record");
  await settle();
}

function setupMedia(pending = false): { grant: () => void } {
  FakeRecorder.instances = [];
  track = new FakeTrack();
  const stream = { getTracks: () => [track] };
  let grant: ((value: unknown) => void) | undefined;
  getUserMedia = vi.fn().mockReturnValue(
    pending
      ? new Promise((resolve) => {
          grant = resolve;
        })
      : Promise.resolve(stream),
  );
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  return { grant: () => grant?.(stream) };
}

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  target?.remove();
  target = null;
  resetExtensionCapture();
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("extension capture tab", () => {
  test("keeps the sandbox closed and posts capture sources on ready", async () => {
    setupMedia();
    const { frame } = await show();
    expect(frame.getAttribute("sandbox")).toBe("allow-forms allow-scripts");
    expect(frame.hasAttribute("allow")).toBe(false);
    const posted = watchPosts(frame);
    fromFrame(frame, { type: "chan:extension-ready:v1" });
    await settle();
    expect(posted).toContainEqual({
      type: EXTENSION_CAPTURE_SOURCES_MESSAGE,
      sources: { microphone: "available" },
    });
  });

  test("open shows the bar without the device and Record starts capture", async () => {
    setupMedia();
    const { frame } = await show();
    openCapture(frame);
    await settle();
    expect(target?.textContent).toContain("Echo wants to record your microphone");
    expect(getUserMedia).not.toHaveBeenCalled();
    clickButton("Record");
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(target?.textContent).toContain("Recording for Echo");
  });

  test("frame reload, remount and a stopped process keep recording alive", async () => {
    setupMedia();
    const { frame, tab } = await show();
    await startRecording(frame);
    expect(FakeRecorder.instances).toHaveLength(1);
    frame.dispatchEvent(new Event("load"));
    await settle();
    expect(track.stopped).toBe(false);
    const frame2 = await remount(tab);
    expect(track.stopped).toBe(false);
    expect(target?.textContent).toContain("Recording for Echo");
    catalog.mockResolvedValue([{ ...ENTRY, running: false }]);
    await refreshExtensions();
    await settle();
    expect(target?.querySelector("iframe")).toBeNull();
    expect(target?.textContent).toContain("Recording for Echo");
    expect(track.stopped).toBe(false);
    expect(captureViewFor(tab.id)?.phase).toBe("recording");
    expect(frame2).toBeTruthy();
  });

  test("closing the tab, losing the grant and losing the extension stop tracks", async () => {
    setupMedia();
    const { frame, tab } = await show();
    await startRecording(frame);
    catalog.mockResolvedValue([{ ...ENTRY, capabilities: [] }]);
    await refreshExtensions();
    await settle();
    expect(track.stopped).toBe(true);
    expect(captureViewFor(tab.id)).toBeUndefined();

    // A fresh recording ends when the extension leaves the catalog.
    catalog.mockResolvedValue([ENTRY]);
    await refreshExtensions();
    await settle();
    const frame2 = target!.querySelector("iframe")!;
    track = new FakeTrack();
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    await startRecording(frame2);
    catalog.mockResolvedValue([]);
    await refreshExtensions();
    await settle();
    expect(track.stopped).toBe(true);

    // Closing the tab ends capture through component teardown.
    catalog.mockResolvedValue([ENTRY]);
    await refreshExtensions();
    await settle();
    const frame3 = await remount(tab);
    track = new FakeTrack();
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    await startRecording(frame3);
    await closeTab(activePane().id, tab.id);
    if (view) await unmount(view);
    view = null;
    expect(track.stopped).toBe(true);
  });

  test("a take that ends leaves focus held outside the tab alone", async () => {
    setupMedia();
    const { frame } = await show();
    const focusFrame = vi.spyOn(frame, "focus");
    await startRecording(frame);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    fromFrame(frame, {
      type: EXTENSION_CAPTURE_REQUEST,
      request_id: "request-1",
      action: "stop",
    });
    await settle();
    expect(document.activeElement).toBe(elsewhere);
    expect(focusFrame).not.toHaveBeenCalled();
    elsewhere.remove();
  });

  test("the frame takes focus when the focused bar button goes away", async () => {
    setupMedia();
    const { frame } = await show();
    const focusFrame = vi.spyOn(frame, "focus");
    await startRecording(frame);
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    const stop = [...target!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Stop",
    )!;
    stop.focus();
    stop.click();
    await settle();
    expect(focusFrame).toHaveBeenCalled();
  });

  test("a grant removed while permission is pending never builds a recorder", async () => {
    const { grant } = setupMedia(true);
    const { frame } = await show();
    openCapture(frame);
    await settle();
    clickButton("Record");
    await settle();
    catalog.mockResolvedValue([{ ...ENTRY, capabilities: [] }]);
    await refreshExtensions();
    await settle();
    grant();
    await settle();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(track.stopped).toBe(true);
  });

  test("a frame without the grant gets not_granted and never the device", async () => {
    setupMedia();
    const { frame } = await show({ ...ENTRY, capabilities: [] });
    const posted = watchPosts(frame);
    openCapture(frame);
    await settle();
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: EXTENSION_CAPTURE_EVENT,
        state: "error",
        code: "not_granted",
      }),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(target?.querySelector(".capture-bar")).toBeNull();
  });

  test("insecure and unsupported contexts report their source status", async () => {
    setupMedia();
    const { frame } = await show();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    let posted = watchPosts(frame);
    fromFrame(frame, { type: "chan:extension-ready:v1" });
    await settle();
    expect(posted).toContainEqual({
      type: EXTENSION_CAPTURE_SOURCES_MESSAGE,
      sources: { microphone: "insecure_context" },
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    vi.stubGlobal("MediaRecorder", undefined);
    posted = watchPosts(frame);
    fromFrame(frame, { type: "chan:extension-ready:v1" });
    await settle();
    expect(posted).toContainEqual({
      type: EXTENSION_CAPTURE_SOURCES_MESSAGE,
      sources: { microphone: "unsupported" },
    });
  });

  test("a take is redelivered after ready until acked", async () => {
    setupMedia();
    const { frame } = await show();
    const posted = watchPosts(frame);
    await startRecording(frame);
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    clickButton("Stop");
    await settle();
    const take = posted.find((message) => message.state === "take");
    expect(take).toMatchObject({ state: "take", redelivered: false });
    expect(target?.textContent).toContain("waiting for Echo");
    posted.length = 0;
    fromFrame(frame, { type: "chan:extension-ready:v1" });
    await settle();
    expect(posted).toContainEqual(
      expect.objectContaining({ state: "take", redelivered: true }),
    );
    posted.length = 0;
    fromFrame(frame, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "ack",
      take_id: (take as { take_id: string }).take_id,
    });
    await settle();
    fromFrame(frame, { type: "chan:extension-ready:v1" });
    await settle();
    expect(posted.some((message) => message.state === "take")).toBe(false);
  });
});
