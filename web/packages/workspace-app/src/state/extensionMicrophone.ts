import {
  EXTENSION_MICROPHONE_EVENT,
  type ExtensionMicrophoneRequest,
} from "./extensionBridge";

export const MAX_MICROPHONE_RECORDING_BYTES = 64 * 1024 * 1024;
export const MAX_MICROPHONE_RECORDING_MS = 10 * 60 * 1000;

export type ExtensionMicrophoneEvent =
  | {
      type: typeof EXTENSION_MICROPHONE_EVENT;
      request_id: string;
      state: "recording";
    }
  | {
      type: typeof EXTENSION_MICROPHONE_EVENT;
      request_id: string;
      state: "complete";
      audio: Blob;
      limited: boolean;
    }
  | {
      type: typeof EXTENSION_MICROPHONE_EVENT;
      request_id: string;
      state: "error";
      message: string;
    };

type ActiveRecording = {
  requestId: string;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  limited: boolean;
};

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone permission was denied or is unavailable.";
    }
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "NotReadableError") return "The microphone could not be read.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Microphone recording failed.";
}

// The parent owns device access so an extension frame keeps its opaque origin.
export class ExtensionMicrophone {
  private active: ActiveRecording | null = null;

  constructor(private readonly post: (event: ExtensionMicrophoneEvent) => void) {}

  handle(request: ExtensionMicrophoneRequest): void {
    if (request.action === "start") void this.start(request.request_id);
    else if (request.action === "stop") this.stop(request.request_id);
    else this.cancel(request.request_id);
  }

  private postError(requestId: string, message: string): void {
    this.post({
      type: EXTENSION_MICROPHONE_EVENT,
      request_id: requestId,
      state: "error",
      message,
    });
  }

  private async start(requestId: string): Promise<void> {
    if (this.active) {
      this.postError(requestId, "A microphone recording is already active.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      this.postError(requestId, "Microphone recording is unavailable in this browser.");
      return;
    }
    const active: ActiveRecording = {
      requestId,
      stream: null,
      recorder: null,
      chunks: [],
      bytes: 0,
      timer: null,
      limited: false,
    };
    this.active = active;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.fail(active, errorMessage(error));
      return;
    }
    // Cancellation while the permission prompt was open still owns the result.
    if (this.active !== active) {
      stopTracks(stream);
      return;
    }
    active.stream = stream;
    try {
      const recorder = new MediaRecorder(stream);
      active.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => this.append(active, event.data));
      recorder.addEventListener("error", () => this.fail(active, "Microphone recording failed."));
      recorder.addEventListener("stop", () => this.complete(active));
      recorder.start(1000);
    } catch (error) {
      this.fail(active, errorMessage(error));
      return;
    }
    active.timer = setTimeout(() => {
      active.limited = true;
      this.stopActive(active);
    }, MAX_MICROPHONE_RECORDING_MS);
    this.post({
      type: EXTENSION_MICROPHONE_EVENT,
      request_id: requestId,
      state: "recording",
    });
  }

  private append(active: ActiveRecording, data: Blob): void {
    if (this.active !== active || data.size === 0) return;
    const remaining = MAX_MICROPHONE_RECORDING_BYTES - active.bytes;
    if (remaining > 0) {
      const chunk = data.slice(0, remaining);
      active.chunks.push(chunk);
      active.bytes += chunk.size;
    }
    if (data.size > remaining || active.bytes === MAX_MICROPHONE_RECORDING_BYTES) {
      active.limited = true;
      this.stopActive(active);
    }
  }

  private stop(requestId: string): void {
    const active = this.active;
    if (!active || active.requestId !== requestId) {
      this.postError(requestId, "This microphone recording is no longer active.");
      return;
    }
    // Stopping while the permission prompt is pending cancels an empty take.
    if (!active.recorder) this.cancel(requestId);
    else this.stopActive(active);
  }

  private stopActive(active: ActiveRecording): void {
    if (this.active !== active || !active.recorder) return;
    if (active.recorder.state !== "inactive") active.recorder.stop();
  }

  cancel(requestId?: string): void {
    const active = this.active;
    if (!active || (requestId !== undefined && active.requestId !== requestId)) return;
    this.active = null;
    if (active.timer !== null) clearTimeout(active.timer);
    if (active.recorder?.state !== "inactive") active.recorder?.stop();
    stopTracks(active.stream);
  }

  private fail(active: ActiveRecording, message: string): void {
    if (this.active !== active) return;
    this.active = null;
    if (active.timer !== null) clearTimeout(active.timer);
    if (active.recorder?.state !== "inactive") active.recorder?.stop();
    stopTracks(active.stream);
    this.postError(active.requestId, message);
  }

  private complete(active: ActiveRecording): void {
    if (this.active !== active || !active.recorder) return;
    this.active = null;
    if (active.timer !== null) clearTimeout(active.timer);
    stopTracks(active.stream);
    if (active.bytes === 0) {
      this.postError(active.requestId, "The microphone recording is empty.");
      return;
    }
    const type = active.recorder.mimeType || active.chunks[0]?.type || "audio/webm";
    this.post({
      type: EXTENSION_MICROPHONE_EVENT,
      request_id: active.requestId,
      state: "complete",
      audio: new Blob(active.chunks, { type }),
      limited: active.limited,
    });
  }
}
