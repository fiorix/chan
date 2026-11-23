// Host-owned capture for extension tabs. A session and its finished takes
// belong to the tab id in this module-level store, so a frame reload, a
// component remount or an extension process exit leaves them untouched.
// Only closing the tab, losing the grant or losing the extension ends them.

import {
  EXTENSION_CAPTURE_EVENT,
  extensionCaptureSourceStatus,
  type ExtensionCaptureEvent,
  type ExtensionCaptureProcessing,
  type ExtensionCaptureRequest,
} from "./extensionBridge";
import { newUuid } from "./ids";
import { notify } from "./notify.svelte";

export const MAX_CAPTURE_MS = 10 * 60 * 1000;
export const CAPTURE_SOFT_BYTES = 56 * 1024 * 1024;
export const CAPTURE_HARD_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOX_TAKES = 4;
export const MAX_OUTBOX_BYTES = 128 * 1024 * 1024;

export type CapturePhase = "armed" | "starting" | "recording" | "finishing";

export type CaptureView = {
  phase: CapturePhase | null;
  requestId: string | null;
  startedAt: number | null;
  maxMs: number;
  outboxCount: number;
  outboxBytes: number;
  extensionName: string;
};

type Take = {
  takeId: string;
  requestId: string;
  audio: Blob;
  mime: string;
  bytes: number;
  durationMs: number;
  startedAt: number;
  end: "stopped" | "limit" | "interrupted";
};

type Session = {
  tabId: string;
  requestId: string;
  maxMs: number;
  processing: ExtensionCaptureProcessing;
  phase: CapturePhase;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  bytes: number;
  startMime: string;
  mime: string;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  end: "stopped" | "limit" | "interrupted";
};

type Entry = {
  tabId: string;
  extensionId: string;
  extensionName: string;
  session: Session | null;
  outbox: Take[];
};

const entries = new Map<string, Entry>();
const posters = new Map<string, (event: ExtensionCaptureEvent) => void>();
let views = $state<Record<string, CaptureView>>({});

const ERROR_MESSAGES = {
  not_granted: "This extension has not been granted microphone access.",
  insecure_context: "Microphone capture needs a secure context.",
  unsupported: "Microphone capture is unavailable in this browser.",
  busy: "A recording is already in progress.",
  outbox_full: "Too many recordings are waiting to be saved.",
  permission_denied: "Microphone permission was denied.",
  no_device: "No microphone was found.",
  device_error: "The microphone could not be read.",
  empty: "The recording is empty.",
  too_large: "The recording is too large.",
  invalid_request: "The capture request is not valid.",
  failed: "Microphone recording failed.",
};

function syncView(entry: Entry): void {
  if (!entry.session && entry.outbox.length === 0) {
    if (views[entry.tabId]) {
      const next = { ...views };
      delete next[entry.tabId];
      views = next;
    }
    return;
  }
  views = {
    ...views,
    [entry.tabId]: {
      phase: entry.session?.phase ?? null,
      requestId: entry.session?.requestId ?? null,
      startedAt: entry.session?.startedAt ?? null,
      maxMs: entry.session?.maxMs ?? MAX_CAPTURE_MS,
      outboxCount: entry.outbox.length,
      outboxBytes: entry.outbox.reduce((sum, take) => sum + take.bytes, 0),
      extensionName: entry.extensionName,
    },
  };
}

function post(tabId: string, event: ExtensionCaptureEvent): void {
  posters.get(tabId)?.(event);
}

function postError(
  tabId: string,
  requestId: string,
  code: keyof typeof ERROR_MESSAGES,
): void {
  post(tabId, {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: requestId,
    state: "error",
    code,
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.failed!,
  });
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // A track that refuses to stop is already gone.
    }
  }
}

function ensureEntry(
  tabId: string,
  extensionId: string,
  extensionName: string,
): Entry {
  let entry = entries.get(tabId);
  if (!entry) {
    entry = { tabId, extensionId, extensionName, session: null, outbox: [] };
    entries.set(tabId, entry);
  } else {
    entry.extensionId = extensionId;
    entry.extensionName = extensionName;
  }
  return entry;
}

function anySession(): boolean {
  for (const entry of entries.values()) if (entry.session) return true;
  return false;
}

function outboxFull(entry: Entry): boolean {
  const bytes = entry.outbox.reduce((sum, take) => sum + take.bytes, 0);
  return entry.outbox.length >= MAX_OUTBOX_TAKES || bytes >= MAX_OUTBOX_BYTES;
}

export function registerCapturePoster(
  tabId: string,
  poster: (event: ExtensionCaptureEvent) => void,
): () => void {
  posters.set(tabId, poster);
  return () => {
    if (posters.get(tabId) === poster) posters.delete(tabId);
  };
}

export function captureViewFor(tabId: string): CaptureView | undefined {
  return views[tabId];
}

export function isCaptureRecording(tabId: string): boolean {
  return views[tabId]?.phase === "recording";
}

export function hasCaptureActivity(): boolean {
  for (const entry of entries.values()) {
    if (entry.session || entry.outbox.length > 0) return true;
  }
  return false;
}

function clearTimer(session: Session): void {
  if (session.timer !== null) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function cancelSession(entry: Entry, by: "viewer" | "extension" | "host"): void {
  const session = entry.session;
  if (!session) return;
  entry.session = null;
  clearTimer(session);
  if (session.recorder && session.recorder.state !== "inactive") {
    try {
      session.recorder.stop();
    } catch {
      // The recorder is already inactive.
    }
  }
  stopTracks(session.stream);
  syncView(entry);
  post(entry.tabId, {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: session.requestId,
    state: "cancelled",
    by,
  });
}

function failSession(
  session: Session,
  code: keyof typeof ERROR_MESSAGES,
): void {
  const entry = entries.get(session.tabId);
  if (!entry || entry.session !== session) return;
  entry.session = null;
  clearTimer(session);
  if (session.recorder && session.recorder.state !== "inactive") {
    try {
      session.recorder.stop();
    } catch {
      // The recorder is already inactive.
    }
  }
  stopTracks(session.stream);
  syncView(entry);
  postError(entry.tabId, session.requestId, code);
}

function beginFinish(session: Session): void {
  const entry = entries.get(session.tabId);
  if (!entry || entry.session !== session) return;
  if (session.phase === "finishing") return;
  session.phase = "finishing";
  clearTimer(session);
  syncView(entry);
  post(entry.tabId, {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: session.requestId,
    state: "finishing",
  });
  if (session.recorder && session.recorder.state !== "inactive") {
    try {
      session.recorder.stop();
    } catch {
      completeTake(session);
    }
  } else {
    completeTake(session);
  }
}

function completeTake(session: Session): void {
  const entry = entries.get(session.tabId);
  if (!entry || entry.session !== session) return;
  entry.session = null;
  clearTimer(session);
  stopTracks(session.stream);
  if (session.bytes === 0) {
    syncView(entry);
    postError(entry.tabId, session.requestId, "empty");
    return;
  }
  const mime = session.mime || session.startMime || "";
  if (session.bytes > CAPTURE_HARD_BYTES) {
    syncView(entry);
    postError(entry.tabId, session.requestId, "too_large");
    return;
  }
  const startedAt = session.startedAt ?? Date.now();
  const take: Take = {
    takeId: newUuid().replaceAll("-", ""),
    requestId: session.requestId,
    audio: new Blob(session.chunks, { type: mime }),
    mime,
    bytes: session.bytes,
    durationMs: Math.max(0, Date.now() - startedAt),
    startedAt,
    end: session.end,
  };
  entry.outbox.push(take);
  syncView(entry);
  post(entry.tabId, takeEvent(take, false));
}

function takeEvent(take: Take, redelivered: boolean): ExtensionCaptureEvent {
  return {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: take.requestId,
    state: "take",
    take_id: take.takeId,
    source: "microphone",
    audio: take.audio,
    mime: take.mime,
    bytes: take.bytes,
    duration_ms: take.durationMs,
    started_at: take.startedAt,
    end: take.end,
    redelivered,
  };
}

function errorCodeFor(error: unknown): keyof typeof ERROR_MESSAGES {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "permission_denied";
    }
    if (error.name === "NotFoundError") return "no_device";
    if (error.name === "NotReadableError") return "device_error";
  }
  return "failed";
}

/// The viewer pressed Record in the capture bar. Only this path touches the
/// device; an extension `open` never does.
export async function startCaptureRecording(tabId: string): Promise<void> {
  const entry = entries.get(tabId);
  const session = entry?.session;
  if (!entry || !session || session.phase !== "armed") return;
  session.phase = "starting";
  syncView(entry);
  post(tabId, {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: session.requestId,
    state: "starting",
  });
  const constraints: MediaStreamConstraints =
    session.processing === "raw"
      ? {
          audio: {
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false },
          },
        }
      : { audio: true };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    failSession(session, errorCodeFor(error));
    return;
  }
  // Cancelled or revoked while permission was pending: release the late
  // stream without constructing a recorder.
  if (entries.get(tabId)?.session !== session) {
    stopTracks(stream);
    return;
  }
  session.stream = stream;
  for (const track of stream.getTracks()) {
    const onEnded = () => {
      if (entries.get(tabId)?.session !== session) return;
      if (session.phase !== "recording") return;
      session.end = "interrupted";
      beginFinish(session);
    };
    if (typeof track.addEventListener === "function") {
      track.addEventListener("ended", onEnded);
    } else {
      (track as MediaStreamTrack).onended = onEnded;
    }
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (error) {
    failSession(session, errorCodeFor(error));
    return;
  }
  session.recorder = recorder;
  recorder.addEventListener("start", () => {
    session.startMime = recorder.mimeType || "";
  });
  recorder.addEventListener("dataavailable", (event: BlobEvent) => {
    if (entries.get(tabId)?.session !== session) return;
    const data = event.data;
    if (!data || data.size === 0) return;
    if (!session.mime && data.type) session.mime = data.type;
    session.chunks.push(data);
    session.bytes += data.size;
    if (session.bytes >= CAPTURE_SOFT_BYTES && session.phase === "recording") {
      session.end = "limit";
      beginFinish(session);
    }
  });
  recorder.addEventListener("error", () => failSession(session, "device_error"));
  recorder.addEventListener("stop", () => completeTake(session));
  try {
    recorder.start(1000);
  } catch (error) {
    failSession(session, errorCodeFor(error));
    return;
  }
  session.startedAt = Date.now();
  session.phase = "recording";
  session.timer = setTimeout(() => {
    if (entries.get(tabId)?.session !== session) return;
    if (session.phase !== "recording") return;
    session.end = "limit";
    beginFinish(session);
  }, session.maxMs);
  syncView(entry);
  post(tabId, {
    type: EXTENSION_CAPTURE_EVENT,
    request_id: session.requestId,
    state: "recording",
    started_at: session.startedAt,
  });
}

export function stopCaptureRecording(tabId: string): void {
  const entry = entries.get(tabId);
  const session = entry?.session;
  if (!entry || !session) return;
  if (session.phase === "recording") {
    beginFinish(session);
  } else if (session.phase === "armed" || session.phase === "starting") {
    cancelSession(entry, "viewer");
  }
}

export function cancelCaptureRecording(
  tabId: string,
  by: "viewer" | "extension" | "host" = "viewer",
): void {
  const entry = entries.get(tabId);
  if (entry) cancelSession(entry, by);
}

export function discardCaptureOutbox(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  entry.outbox = [];
  if (!entry.session) entries.delete(tabId);
  syncView(entry);
}

/// Handle one validated request from the tab's own frame.
export function handleCaptureRequest(
  tabId: string,
  info: { extensionId: string; extensionName: string; granted: boolean },
  request: ExtensionCaptureRequest,
): void {
  const entry = ensureEntry(tabId, info.extensionId, info.extensionName);
  if (request.action === "ack") {
    entry.outbox = entry.outbox.filter((take) => take.takeId !== request.take_id);
    if (!entry.session && entry.outbox.length === 0) entries.delete(tabId);
    syncView(entry);
    return;
  }
  if (request.action === "open") {
    const status = extensionCaptureSourceStatus(info.granted);
    if (status !== "available") {
      postError(tabId, request.request_id, status);
      return;
    }
    if (anySession()) {
      postError(tabId, request.request_id, "busy");
      return;
    }
    if (outboxFull(entry)) {
      postError(tabId, request.request_id, "outbox_full");
      return;
    }
    entry.session = {
      tabId,
      requestId: request.request_id,
      maxMs: request.max_ms ?? MAX_CAPTURE_MS,
      processing: request.processing ?? "voice",
      phase: "armed",
      stream: null,
      recorder: null,
      chunks: [],
      bytes: 0,
      startMime: "",
      mime: "",
      startedAt: null,
      timer: null,
      end: "stopped",
    };
    syncView(entry);
    post(tabId, {
      type: EXTENSION_CAPTURE_EVENT,
      request_id: request.request_id,
      state: "armed",
    });
    return;
  }
  const session = entry.session;
  if (!session || session.requestId !== request.request_id) {
    postError(tabId, request.request_id, "invalid_request");
    return;
  }
  if (request.action === "cancel") {
    cancelSession(entry, "extension");
    return;
  }
  // stop
  if (session.phase === "armed" || session.phase === "starting") {
    cancelSession(entry, "extension");
  } else if (session.phase === "recording") {
    beginFinish(session);
  }
}

/// Re-post unacked takes oldest first, then the live session state, after a
/// frame posts ready.
export function redeliverCapture(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  for (const take of entry.outbox) post(tabId, takeEvent(take, true));
  const session = entry.session;
  if (!session) return;
  if (session.phase === "recording" && session.startedAt !== null) {
    post(tabId, {
      type: EXTENSION_CAPTURE_EVENT,
      request_id: session.requestId,
      state: "recording",
      started_at: session.startedAt,
    });
  } else if (session.phase !== "recording") {
    post(tabId, {
      type: EXTENSION_CAPTURE_EVENT,
      request_id: session.requestId,
      state: session.phase,
    });
  }
}

/// End the tab's session and drop its outbox. Used when the tab closes, the
/// grant goes away or the extension leaves the catalog.
export function disposeCaptureTab(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  const dropped =
    entry.outbox.length +
    (entry.session &&
    (entry.session.phase === "starting" ||
      entry.session.phase === "recording" ||
      entry.session.phase === "finishing")
      ? 1
      : 0);
  const name = entry.extensionName;
  if (entry.session) cancelSession(entry, "host");
  entries.delete(tabId);
  views = (() => {
    const next = { ...views };
    delete next[tabId];
    return next;
  })();
  if (dropped > 0) {
    notify(
      dropped === 1
        ? `Discarded 1 recording for ${name}.`
        : `Discarded ${dropped} recordings for ${name}.`,
    );
  }
}

export function resetExtensionCapture(): void {
  for (const entry of [...entries.values()]) {
    if (entry.session) {
      clearTimer(entry.session);
      stopTracks(entry.session.stream);
    }
  }
  entries.clear();
  posters.clear();
  views = {};
}
