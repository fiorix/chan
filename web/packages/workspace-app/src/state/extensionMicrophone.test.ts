// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  EXTENSION_MICROPHONE_EVENT,
  EXTENSION_MICROPHONE_REQUEST,
  type ExtensionMicrophoneAction,
  type ExtensionMicrophoneRequest,
} from "./extensionBridge";
import {
  ExtensionMicrophone,
  MAX_MICROPHONE_RECORDING_BYTES,
  MAX_MICROPHONE_RECORDING_MS,
  type ExtensionMicrophoneEvent,
} from "./extensionMicrophone";

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly stream: MediaStream) {
    FakeRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => this.emit("stop", new Event("stop")));
  }

  data(bytes: number): void {
    this.emit("dataavailable", new MessageEvent("dataavailable", { data: new Blob([new Uint8Array(bytes)]) }));
  }

  fail(): void {
    this.emit("error", new Event("error"));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function request(action: ExtensionMicrophoneAction, id = "request-1"): ExtensionMicrophoneRequest {
  return { type: EXTENSION_MICROPHONE_REQUEST, request_id: id, action };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("extension microphone recorder", () => {
  let events: ExtensionMicrophoneEvent[];
  let microphone: ExtensionMicrophone;
  let track: FakeTrack;
  let stream: FakeStream;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    FakeRecorder.instances = [];
    events = [];
    microphone = new ExtensionMicrophone((event) => events.push(event));
    track = new FakeTrack();
    stream = new FakeStream(track);
    getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    microphone.cancel();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("records, returns audio, and releases the microphone on stop", async () => {
    microphone.handle(request("start"));
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(events).toEqual([
      { type: EXTENSION_MICROPHONE_EVENT, request_id: "request-1", state: "recording" },
    ]);
    const recorder = FakeRecorder.instances[0]!;
    recorder.data(4);
    microphone.handle(request("stop"));
    await settle();
    expect(track.stopped).toBe(true);
    expect(events[1]).toMatchObject({ request_id: "request-1", state: "complete", limited: false });
    const complete = events[1] as Extract<ExtensionMicrophoneEvent, { state: "complete" }>;
    expect(complete.audio.size).toBe(4);
    expect(complete.audio.type).toBe("audio/webm");
  });

  test("reports permission denial without constructing a recorder", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    microphone.handle(request("start"));
    await settle();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(events[0]).toMatchObject({
      state: "error",
      message: "Microphone permission was denied or is unavailable.",
    });
  });

  test("rejects duplicate starts and stale stops without disturbing the active take", async () => {
    microphone.handle(request("start"));
    await settle();
    microphone.handle(request("start", "request-2"));
    microphone.handle(request("stop", "stale"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.state)).toEqual(["recording", "error", "error"]);
    expect(track.stopped).toBe(false);
  });

  test("cancel discards audio and releases tracks", async () => {
    microphone.handle(request("start"));
    await settle();
    FakeRecorder.instances[0]!.data(4);
    microphone.handle(request("cancel"));
    await settle();
    expect(track.stopped).toBe(true);
    expect(events.map((event) => event.state)).toEqual(["recording"]);
  });

  test("cancel while permission is pending releases the late stream", async () => {
    let grant: ((value: FakeStream) => void) | undefined;
    getUserMedia.mockReturnValue(new Promise((resolve) => (grant = resolve)));
    microphone.handle(request("start"));
    microphone.handle(request("cancel"));
    grant!(stream);
    await settle();
    expect(track.stopped).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(events).toEqual([]);
  });

  test("the byte limit saves only the allowed bytes", async () => {
    microphone.handle(request("start"));
    await settle();
    FakeRecorder.instances[0]!.data(MAX_MICROPHONE_RECORDING_BYTES + 1);
    await settle();
    const complete = events[1] as Extract<ExtensionMicrophoneEvent, { state: "complete" }>;
    expect(complete.state).toBe("complete");
    expect(complete.audio.size).toBe(MAX_MICROPHONE_RECORDING_BYTES);
    expect(complete.limited).toBe(true);
    expect(track.stopped).toBe(true);
  });

  test("the duration limit stops and saves the take", async () => {
    vi.useFakeTimers();
    microphone.handle(request("start"));
    await vi.advanceTimersByTimeAsync(0);
    FakeRecorder.instances[0]!.data(4);
    await vi.advanceTimersByTimeAsync(MAX_MICROPHONE_RECORDING_MS);
    const complete = events[1] as Extract<ExtensionMicrophoneEvent, { state: "complete" }>;
    expect(complete.state).toBe("complete");
    expect(complete.limited).toBe(true);
    expect(track.stopped).toBe(true);
  });

  test("empty recordings and recorder errors fail without audio", async () => {
    microphone.handle(request("start"));
    await settle();
    const recorder = FakeRecorder.instances[0]!;
    recorder.fail();
    expect(events[1]).toMatchObject({ state: "error", message: "Microphone recording failed." });
    expect(track.stopped).toBe(true);

    microphone.handle(request("start", "request-2"));
    await settle();
    microphone.handle(request("stop", "request-2"));
    await settle();
    expect(events[3]).toMatchObject({
      request_id: "request-2",
      state: "error",
      message: "The microphone recording is empty.",
    });
  });
});
