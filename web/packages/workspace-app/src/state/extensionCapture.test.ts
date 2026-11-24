// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  EXTENSION_CAPTURE_REQUEST,
  type ExtensionCaptureEvent,
  type ExtensionCaptureRequest,
} from "./extensionBridge";
import {
  CAPTURE_FINISH_TIMEOUT_MS,
  CAPTURE_HARD_BYTES,
  CAPTURE_SOFT_BYTES,
  captureViewFor,
  disposeCaptureTab,
  handleCaptureRequest,
  isCaptureRecording,
  redeliverCapture,
  registerCapturePoster,
  rejectCaptureRequest,
  resetExtensionCapture,
  startCaptureRecording,
  stopAllCaptureRecordings,
  stopCaptureRecording,
} from "./extensionCapture.svelte";
import { setTransferSignalSink, windowActivityCount } from "./transfers.svelte";

class FakeTrack extends EventTarget {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static supported: string[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeRecorder.supported.includes(type);
  }
  state: RecordingState = "inactive";
  mimeType: string;
  clearMimeOnStop = false;
  stopAnswers = true;
  constructor(
    readonly stream: unknown,
    readonly options?: MediaRecorderOptions,
  ) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = "recording";
    this.dispatchEvent(new Event("start"));
  }
  stop(): void {
    this.state = "inactive";
    if (this.clearMimeOnStop) this.mimeType = "";
    if (!this.stopAnswers) return;
    queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  }
  data(blob: Blob): void {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
  }
}

const INFO = { extensionId: "echo", extensionName: "Echo", granted: true };

function open(id = "request-1", extra: Record<string, unknown> = {}): void {
  handleCaptureRequest("tab1", INFO, {
    type: EXTENSION_CAPTURE_REQUEST,
    action: "open",
    request_id: id,
    source: "microphone",
    ...extra,
  } as ExtensionCaptureRequest);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function recordTake(id: string, bytes = 4): Promise<ExtensionCaptureEvent> {
  open(id);
  await startCaptureRecording("tab1");
  await settle();
  FakeRecorder.instances.at(-1)!.data(new Blob([new Uint8Array(bytes)]));
  stopCaptureRecording("tab1");
  await settle();
  return events.at(-1)!;
}

let events: ExtensionCaptureEvent[];
let track: FakeTrack;
let stream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  FakeRecorder.instances = [];
  FakeRecorder.supported = [];
  events = [];
  resetExtensionCapture();
  registerCapturePoster("tab1", (event) => events.push(event));
  registerCapturePoster("tab2", (event) => events.push(event));
  track = new FakeTrack();
  stream = new FakeStream(track);
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  resetExtensionCapture();
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("extension capture store", () => {
  test("open arms without touching the device and Record starts capture", async () => {
    open();
    expect(events).toMatchObject([{ state: "armed", request_id: "request-1" }]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(captureViewFor("tab1")?.phase).toBe("armed");
    await startCaptureRecording("tab1");
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(events.map((e) => e.state)).toEqual(["armed", "starting", "recording"]);
    expect(isCaptureRecording("tab1")).toBe(true);
    expect(windowActivityCount()).toBe(1);
  });

  test("an armed bar holds no audio, so it does not guard the window", () => {
    open();
    expect(windowActivityCount()).toBe(0);
  });

  test("the window signal follows a take until it is acked", async () => {
    const signals: number[] = [];
    setTransferSignalSink((active) => signals.push(active));
    const take = await recordTake("request-1");
    if (take.state !== "take") throw new Error("expected take");
    expect(signals.at(-1)).toBe(1);
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "ack",
      take_id: take.take_id,
    } as ExtensionCaptureRequest);
    setTransferSignalSink(null);
    expect(signals.at(-1)).toBe(0);
  });

  test("the recorder gets the first supported Opus type", async () => {
    FakeRecorder.supported = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];
    open();
    await startCaptureRecording("tab1");
    await settle();
    expect(FakeRecorder.instances[0]!.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
    });
  });

  test("a platform without any listed type keeps its own default", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    expect(FakeRecorder.instances[0]!.options).toBeUndefined();
  });

  test("a recorder the platform refuses reports unsupported and frees the device", async () => {
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported(): boolean {
          return true;
        }
        constructor() {
          throw new DOMException("unsupported", "NotSupportedError");
        }
      },
    );
    open();
    await startCaptureRecording("tab1");
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "error", code: "unsupported" });
    expect(track.stopped).toBe(true);
    expect(captureViewFor("tab1")).toBeUndefined();
  });

  test("raw processing asks for processing off as ideal constraints", async () => {
    open("request-1", { processing: "raw" });
    await startCaptureRecording("tab1");
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    });
  });

  test("a second open gets busy while one session is live", async () => {
    open();
    handleCaptureRequest(
      "tab2",
      INFO,
      {
        type: EXTENSION_CAPTURE_REQUEST,
        action: "open",
        request_id: "request-2",
        source: "microphone",
      } as ExtensionCaptureRequest,
    );
    expect(events.at(-1)).toMatchObject({
      request_id: "request-2",
      state: "error",
      code: "busy",
    });
  });

  test("no grant, insecure context and unsupported each refuse open", () => {
    handleCaptureRequest("tab1", { ...INFO, granted: false }, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "open",
      request_id: "a",
      source: "microphone",
    } as ExtensionCaptureRequest);
    expect(events.at(-1)).toMatchObject({ state: "error", code: "not_granted" });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    open("b");
    expect(events.at(-1)).toMatchObject({ state: "error", code: "insecure_context" });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    vi.stubGlobal("MediaRecorder", undefined);
    open("c");
    expect(events.at(-1)).toMatchObject({ state: "error", code: "unsupported" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  test("extension stop finalizes a take and stop before recording cancels", async () => {
    const take = await recordTake("request-1");
    expect(take).toMatchObject({ state: "take", end: "stopped", bytes: 4 });
    if (take.state !== "take") throw new Error("expected take");
    expect(take.take_id).toMatch(/^[0-9a-f]{32}$/);
    expect(take.redelivered).toBe(false);
    expect(track.stopped).toBe(true);
    open("request-2");
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "stop",
      request_id: "request-2",
    } as ExtensionCaptureRequest);
    expect(events.at(-1)).toMatchObject({ state: "cancelled", by: "extension" });
  });

  test("a take is redelivered after ready until acked, then never again", async () => {
    const take = await recordTake("request-1");
    if (take.state !== "take") throw new Error("expected take");
    events = [];
    redeliverCapture("tab1");
    expect(events).toMatchObject([
      { state: "take", take_id: take.take_id, redelivered: true },
    ]);
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "ack",
      take_id: take.take_id,
    } as ExtensionCaptureRequest);
    events = [];
    redeliverCapture("tab1");
    expect(events).toEqual([]);
    expect(windowActivityCount()).toBe(0);
  });

  test("outbox_full is returned once four takes are waiting", async () => {
    for (let i = 1; i <= 4; i += 1) await recordTake(`request-${i}`);
    expect(captureViewFor("tab1")?.outboxCount).toBe(4);
    events = [];
    open("request-5");
    expect(events).toMatchObject([{ state: "error", code: "outbox_full" }]);
  });

  test("a new take must fit the outbox at its hard limit", async () => {
    await recordTake("request-1", CAPTURE_HARD_BYTES);
    open("request-2");
    expect(events.at(-1)).toMatchObject({ state: "armed", request_id: "request-2" });
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "cancel",
      request_id: "request-2",
    } as ExtensionCaptureRequest);
    await recordTake("request-3", 1);
    events = [];
    open("request-4");
    expect(events).toMatchObject([{ state: "error", code: "outbox_full" }]);
  });

  test("a recorder that clears its type on stop keeps the chunk type", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    const recorder = FakeRecorder.instances[0]!;
    recorder.mimeType = "audio/mp4";
    recorder.clearMimeOnStop = true;
    recorder.data(new Blob(["\0\0\0\x18ftypM4A "], { type: "audio/mp4" }));
    stopCaptureRecording("tab1");
    await settle();
    const take = events.at(-1)!;
    expect(take).toMatchObject({ state: "take", mime: "audio/mp4" });
    if (take.state !== "take") throw new Error("expected take");
    expect(take.audio.type).toBe("audio/mp4");
  });

  test("the start-event type is the fallback and unknown stays empty", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    const recorder = FakeRecorder.instances[0]!;
    recorder.clearMimeOnStop = true;
    recorder.data(new Blob([new Uint8Array(4)]));
    stopCaptureRecording("tab1");
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "take", mime: "audio/webm" });
    // Ack the first take, then a take with no type anywhere stays untyped.
    const first = events.at(-1);
    if (first?.state !== "take") throw new Error("expected take");
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "ack",
      take_id: first.take_id,
    } as ExtensionCaptureRequest);
    open("request-2");
    await startCaptureRecording("tab1");
    await settle();
    const second = FakeRecorder.instances[1]!;
    second.mimeType = "";
    second.dispatchEvent(new Event("start"));
    second.clearMimeOnStop = true;
    second.data(new Blob([new Uint8Array(4)]));
    stopCaptureRecording("tab1");
    await settle();
    const take = events.at(-1)!;
    expect(take).toMatchObject({ state: "take", mime: "" });
    if (take.state !== "take") throw new Error("expected take");
    expect(take.audio.type).toBe("");
  });

  test("the soft size limit finishes a complete take at the limit", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.data(
      new Blob([new Uint8Array(CAPTURE_SOFT_BYTES)]),
    );
    await settle();
    const take = events.at(-1)!;
    expect(take).toMatchObject({
      state: "take",
      end: "limit",
      bytes: CAPTURE_SOFT_BYTES,
    });
  });

  test("a take past the hard cap fails as too_large and is never clipped", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.data(
      new Blob([new Uint8Array(CAPTURE_HARD_BYTES + 1)]),
    );
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "error", code: "too_large" });
    expect(events.some((e) => e.state === "take")).toBe(false);
    expect(captureViewFor("tab1")).toBeUndefined();
  });

  test("the duration limit finishes a complete take", async () => {
    vi.useFakeTimers();
    open("request-1", { max_ms: 1000 });
    void startCaptureRecording("tab1");
    await vi.advanceTimersByTimeAsync(0);
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "take", end: "limit" });
  });

  test("a track that ends on its own yields an interrupted take", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    track.end();
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "take", end: "interrupted" });
  });

  test("a recorder error keeps the audio captured so far", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    const recorder = FakeRecorder.instances[0]!;
    recorder.data(new Blob([new Uint8Array(4)]));
    recorder.state = "inactive";
    recorder.dispatchEvent(new Event("error"));
    recorder.data(new Blob([new Uint8Array(2)]));
    recorder.dispatchEvent(new Event("stop"));
    await settle();
    expect(events.at(-1)).toMatchObject({
      state: "take",
      end: "interrupted",
      bytes: 6,
    });
    expect(track.stopped).toBe(true);
  });

  test("a recorder error with no audio is a device error", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.dispatchEvent(new Event("error"));
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "error", code: "device_error" });
    expect(track.stopped).toBe(true);
  });

  test("a recorder that never answers stop frees the capture slot", async () => {
    vi.useFakeTimers();
    open();
    void startCaptureRecording("tab1");
    await vi.advanceTimersByTimeAsync(0);
    const recorder = FakeRecorder.instances[0]!;
    recorder.stopAnswers = false;
    recorder.data(new Blob([new Uint8Array(4)]));
    stopCaptureRecording("tab1");
    await vi.advanceTimersByTimeAsync(CAPTURE_FINISH_TIMEOUT_MS - 1);
    expect(captureViewFor("tab1")?.phase).toBe("finishing");
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)).toMatchObject({ state: "take", end: "interrupted" });
    expect(captureViewFor("tab1")?.phase).toBeNull();
    open("request-2");
    expect(events.at(-1)).toMatchObject({ state: "armed", request_id: "request-2" });
  });

  test("stopping every recording keeps the take and clears armed bars", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    stopAllCaptureRecordings();
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "take", end: "stopped" });
    expect(track.stopped).toBe(true);
    handleCaptureRequest(
      "tab2",
      INFO,
      {
        type: EXTENSION_CAPTURE_REQUEST,
        action: "open",
        request_id: "request-2",
        source: "microphone",
      } as ExtensionCaptureRequest,
    );
    stopAllCaptureRecordings();
    expect(events.at(-1)).toMatchObject({ state: "cancelled", by: "host" });
  });

  test("a refused message is answered only when it names a usable request", () => {
    rejectCaptureRequest("tab1", { request_id: "request-1" });
    expect(events).toMatchObject([
      { state: "error", code: "invalid_request", request_id: "request-1" },
    ]);
    events = [];
    rejectCaptureRequest("tab1", { request_id: "" });
    rejectCaptureRequest("tab1", { request_id: "x".repeat(129) });
    rejectCaptureRequest("tab1", { request_id: 7 });
    expect(events).toEqual([]);
  });

  test("an empty recording fails as empty", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    stopCaptureRecording("tab1");
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "error", code: "empty" });
  });

  test("cancel while permission is pending releases the late stream", async () => {
    let grant: ((value: FakeStream) => void) | undefined;
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    open();
    void startCaptureRecording("tab1");
    await settle();
    handleCaptureRequest("tab1", INFO, {
      type: EXTENSION_CAPTURE_REQUEST,
      action: "cancel",
      request_id: "request-1",
    } as ExtensionCaptureRequest);
    expect(events.at(-1)).toMatchObject({ state: "cancelled", by: "extension" });
    grant!(stream);
    await settle();
    expect(track.stopped).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(events.map((e) => e.state)).toEqual(["armed", "starting", "cancelled"]);
  });

  test("permission denial and a missing device map to their codes", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    open();
    await startCaptureRecording("tab1");
    await settle();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      state: "error",
      code: "permission_denied",
    });
    getUserMedia.mockRejectedValue(new DOMException("none", "NotFoundError"));
    open("request-2");
    await startCaptureRecording("tab1");
    await settle();
    expect(events.at(-1)).toMatchObject({ state: "error", code: "no_device" });
    // WebKit rejects with its own class, which is not a DOMException.
    getUserMedia.mockRejectedValue(
      Object.assign(new Error("no device"), { name: "OverconstrainedError" }),
    );
    open("request-3");
    await startCaptureRecording("tab1");
    await settle();
    expect(events.at(-1)).toMatchObject({
      request_id: "request-3",
      state: "error",
      code: "no_device",
    });
  });

  test("disposing a tab stops every track", async () => {
    open();
    await startCaptureRecording("tab1");
    await settle();
    FakeRecorder.instances[0]!.data(new Blob([new Uint8Array(4)]));
    disposeCaptureTab("tab1");
    expect(track.stopped).toBe(true);
    expect(windowActivityCount()).toBe(0);
    expect(captureViewFor("tab1")).toBeUndefined();
  });
});
