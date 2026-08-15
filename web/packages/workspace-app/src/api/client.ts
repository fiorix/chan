// API client. The typed surface lives here; wire mechanics
// (token plumbing, fetch shape, WebSocket reconnect) live in
// `./transport.ts`. Both `chan open` and the Tauri desktop shell
// reach the same in-process server over loopback HTTP+WS, so there
// is one transport implementation rather than platform-specific clients.

import type {
  BuildInfo,
  ConfigPatchRequest,
  ContentSearchResponse,
  DraftInspectResponse,
  DraftPromoteResponse,
  ExcludedDirsView,
  ExtensionInfo,
  FileResponse,
  FileWriteResponse,
  FsGraphResponse,
  PreflightSnapshot,
  PreflightDecisionRequest,
  CsLinkResult,
  GlobalConfig,
  GraphEdge,
  GraphSnapshot,
  GraphView,
  GraphViewEdge,
  GraphViewNode,
  HeadingRow,
  HealthResponse,
  InspectorPayload,
  IndexStatus,
  IndexerStatus,
  IndexingStateResponse,
  LanguageGraphResponse,
  LinkTarget,
  MetadataExportDownload,
  MetadataImportReport,
  MoveResponse,
  TransferOp,
  TransferResponse,
  ReportFileStats,
  ReportPrefix,
  ResetMode,
  ResetResponse,
  SearchHit,
  SemanticState,
  SemanticModelRegistry,
  TerminalRestartRequest,
  TerminalRosterEntry,
  TerminalSpawnRequest,
  TerminalSpawnResponse,
  TreeEntry,
  WorkspaceInfo,
  WorkspaceReadiness,
  BubbleOverlayMode,
  FsContext,
} from "./types";
import { ApiError } from "./errors";
import { updateGlobalConfigSerial } from "./preferenceWrite";
import {
  apiPath,
  authToken as transportAuthToken,
  chanFetch,
  createXhr,
  openWatch,
  request,
  requestRoot,
  withGatewayCsrfRetry,
  withTokenQuery as transportWithTokenQuery,
} from "./transport";
import type { WatchSocket } from "./transport";
import type { WatchScopeDir } from "./types";

export { ApiError } from "./errors";

/// Auth token for the current session (or null on a `--no-token`
/// server). Exported for the few call sites that build URLs outside
/// the api wrapper (e.g. `<img src>` in the editor's image extension,
/// the multipart upload helper).
export function authToken(): string | null {
  return transportAuthToken();
}

/// Append the auth token as a `?t=...` query. Use only for paths
/// that cannot carry an `Authorization` header (WebSocket upgrade,
/// `<img>` rendered by the browser).
export function withTokenQuery(path: string): string {
  return transportWithTokenQuery(path);
}

const BROWSER_SESSION_WINDOW_KEY = "chan.session.window";
let sessionStorageWarningShown = false;

function randomBrowserSessionId(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function browserSessionWindowId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.sessionStorage.getItem(BROWSER_SESSION_WINDOW_KEY);
    if (existing?.trim()) return existing.trim();
    const generated = randomBrowserSessionId();
    window.sessionStorage.setItem(BROWSER_SESSION_WINDOW_KEY, generated);
    return generated;
  } catch {
    if (!sessionStorageWarningShown) {
      sessionStorageWarningShown = true;
      console.warn("[chan] sessionStorage unavailable; falling back to shared session key");
    }
    return null;
  }
}

/// Session blob key for this browser/webview window. chan-desktop
/// appends `?w=<window-label>` to each workspace window URL; plain browser
/// tabs get a per-tab sessionStorage key so they do not overwrite
/// each other. If storage is unavailable we fall back to historical
/// shared `default` behavior.
export function sessionWindowId(): string {
  if (typeof window === "undefined") return "default";
  const raw = new URL(window.location.href).searchParams.get("w");
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  return browserSessionWindowId() ?? "default";
}

/// Per-SPA-instance client nonce, carried as `&client=` on every
/// session-blob request. The server echoes it in the `session_changed`
/// broadcast so co-viewers of the same `?w=` can tell whose write a
/// notification describes; this window drops frames carrying its own
/// nonce. Module-level on purpose: one nonce per SPA instance, minted
/// fresh on each load (a reloaded window refetches the blob anyway).
const clientNonceValue: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : [randomBrowserSessionId(), randomBrowserSessionId(), randomBrowserSessionId(), randomBrowserSessionId()].join("-");

export function clientNonce(): string {
  return clientNonceValue;
}

/// Whether this window is the standalone Files application (`?kind=files`),
/// read straight off the URL like `?w=` and `?lib=` so the api layer stays
/// independent of the state modules.
export function isFilesWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URL(window.location.href).searchParams.get("kind") === "files";
}

/// Query suffix a mutating call needs on the standalone Files tenant, and
/// nothing at all anywhere else. `w` names the writing window so the server
/// attributes the change back to it (a window must not read its own save as
/// an external edit), and `app=files` selects the Files contract on a route
/// whose path serves two of them.
export function filesMutationSuffix(
  existingQuery: boolean,
  opts: { app?: boolean } = {},
): string {
  if (!isFilesWindow()) return "";
  const params = new URLSearchParams();
  if (opts.app) params.set("app", "files");
  params.set("w", sessionWindowId());
  return `${existingQuery ? "&" : "?"}${params.toString()}`;
}

export function sessionPath(): string {
  const base = `/api/session?w=${encodeURIComponent(sessionWindowId())}&client=${encodeURIComponent(clientNonceValue)}`;
  // A Files window's layout lives in its own blob namespace so a client
  // booted in Terminal-only mode can never restore browser/editor tabs
  // against routes it does not have.
  return isFilesWindow() ? `${base}&app=files` : base;
}

/// The chan-library this window belongs to. The library backend appends
/// `?lib=<library_id>` to each window URL next to `?w=`/`?kind=` (the local
/// disk library stamps `local`, a devserver stamps `lib-<hex>`); when absent
/// (plain browser tab, no library plumbing) we default to `local` to match the
/// backend default for the local library. Guarded for non-browser (test)
/// contexts where `window` is undefined.
export function windowLibraryId(): string {
  if (typeof window === "undefined") return "local";
  const raw = new URL(window.location.href).searchParams.get("lib");
  const trimmed = raw?.trim();
  return trimmed ? trimmed : "local";
}

/// Cross-window tab-DnD compatibility key. Two chan-desktop windows may
/// exchange tabs only when these match. Keyed on the owning CHAN-LIBRARY, the
/// window KIND, and the WORKSPACE IDENTITY the SPA actually loaded, NOT the
/// `?w=` window label, which is an opaque per-window id (`w-<hex>`, set by the
/// desktop window watcher) that differs between two windows of the SAME
/// workspace. A terminal-only window scopes as `lib:{id}|terminal` (every
/// standalone terminal in one library shares its `/terminal` tenant, so
/// terminal-to-terminal moves stay allowed within the same library); a workspace
/// window scopes as `lib:{id}|workspace:{key}` keyed on its stable identity, so
/// two windows of one workspace share a scope while different workspaces, and
/// terminal-to-workspace, get distinct scopes. The `library_id` prefix makes both
/// rules library-aware by string equality: a terminal accepts a drop only from
/// the same library, and a workspace tab only within the same workspace AND the
/// same library (so a workspace-key collision across libraries stays rejected).
/// The caller supplies the identity (`workspace.info`'s `metadata_key`/`root`)
/// and the library id because this module is below the workspace store.
export function windowDragScope(scope: {
  libraryId: string;
  terminalOnly: boolean;
  files: boolean;
  workspaceKey: string | null;
}): string {
  if (scope.terminalOnly) return `lib:${scope.libraryId}|terminal`;
  // Files windows partition their own scope: tabs (terminals included)
  // move between same-library Files windows only, never into a Terminal
  // or Workspace window.
  if (scope.files) return `lib:${scope.libraryId}|files`;
  return `lib:${scope.libraryId}|workspace:${scope.workspaceKey ?? "unknown"}`;
}

/// MIME-safe encoding of a drag scope for use as a DataTransfer TYPE string.
/// The scope rides a MIME TYPE (not a value) because only `types`, not values,
/// are readable during `dragover`. But `windowDragScope` is human-readable and
/// carries `:` and `|`, which are not MIME-type token characters; WKWebView
/// normalizes/mangles such a type, so the string the source stamps does NOT come
/// back byte-identically through `dataTransfer.types` at dragover -- the equality
/// check then fails for EVERY drop, intra-window pane moves included. Hex-encoding
/// the UTF-8 bytes yields only `[0-9a-f]`, which survives normalization unchanged,
/// so the source's stamped type equals the target's recomputed one for the same
/// scope. The scope is only ever compared for EQUALITY, never parsed back, so a
/// one-way bijective encoding is sufficient and collision-free.
export function dragScopeMimeToken(scope: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(scope)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function req<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return request<T>(method, path, body, signal, timeoutMs);
}

type IndexStatusWire = IndexerStatus & {
  readiness: WorkspaceReadiness;
};

/// Contract-5 decision boundary. Progress fields are deliberately invisible
/// here: a response is recovering if and only if its readiness tag says so.
export function workspaceIsRecovering(
  readiness: WorkspaceReadiness,
): readiness is Extract<WorkspaceReadiness, { state: "recovering" }> {
  return readiness.state === "recovering";
}

function readIndexStatus(response: IndexStatusWire): IndexStatus {
  if (workspaceIsRecovering(response.readiness)) {
    return {
      state: "recovering",
      readiness: response.readiness,
    };
  }
  const { readiness: _readiness, ...status } = response;
  return status;
}

function readContentSearch(
  response: ContentSearchResponse,
): ContentSearchResponse {
  if (!workspaceIsRecovering(response.readiness)) return response;
  return {
    ...response,
    ready: false,
    hits: [],
  };
}

function directAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const tk = transportAuthToken();
  if (tk) headers.authorization = `Bearer ${tk}`;
  return headers;
}

function responseTextError(res: Response): Promise<never> {
  return res.text()
    .catch(() => res.statusText)
    .then((text) => {
      let data: unknown = null;
      let message = text || res.statusText;
      if (text) {
        try {
          data = JSON.parse(text);
          if (
            data &&
            typeof data === "object" &&
            "error" in (data as Record<string, unknown>) &&
            typeof (data as { error: unknown }).error === "string"
          ) {
            message = (data as { error: string }).error;
          }
        } catch {
          // Keep the raw text fallback.
        }
      }
      throw new ApiError(res.status, message, data);
    });
}

function xhrTextError(status: number, statusText: string, text: string): never {
  let message = text || statusText || "request failed";
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      message = body.error;
    }
  } catch {
    // Keep the raw text fallback.
  }
  throw new ApiError(status, message);
}

interface UploadProgressOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    loaded: number;
    total: number | null;
    lengthComputable: boolean;
  }) => void;
  /// Opt this request into server admission reporting. Supplying it sends the
  /// window and transfer headers, which is what makes the server emit queue
  /// frames for this transfer. Omitting it changes nothing about admission:
  /// the request is still admitted and still obeys the same bound, it simply
  /// reports no position. Untracked is a normal case, not a degraded one.
  transferId?: string;
}

interface XhrResponse {
  status: number;
  statusText: string;
  responseText: string;
  /// `Retry-After` in seconds when the server sent one, else null. Only the
  /// admission refusal below reads it.
  retryAfterSeconds: number | null;
}

/// Detail carried on the admission refusal, reachable through `ApiError.data`.
export interface TransferBusyDetail {
  retryAfterSeconds: number | null;
}

/// `Retry-After` in seconds, or null when it is absent or unusable. A missing
/// header must stay null rather than becoming 0: `Number(null)` and
/// `Number("")` are both 0, which would read as "retry immediately" instead of
/// "not stated".
function parseRetryAfterSeconds(raw: string | null): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds : null;
}

/// True when the server refused a transfer at its admission bound rather than
/// failing one. Nothing was read and nothing was written, so this is not a
/// transfer failure and must not be reported to the user as one: the correct
/// response is to wait the stated interval and try again, and the correct
/// wording is that the server is busy.
export function isTransferBusyError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    typeof (error.data as TransferBusyDetail | null)?.retryAfterSeconds !== "undefined"
  );
}

/// Seconds to wait before retrying a refused transfer. Falls back to 1, the
/// value the server sends today, when the header is missing or unparseable.
export function transferRetryAfterSeconds(error: unknown): number {
  const detail = error instanceof ApiError ? (error.data as TransferBusyDetail | null) : null;
  const seconds = detail?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : 1;
}

function uploadXhrAttempt(
  form: FormData,
  opts: UploadProgressOptions,
  csrfHeaders: [string, string][],
): Promise<XhrResponse> {
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    xhr.open(
      "POST",
      apiPath(`/api/files/upload${filesMutationSuffix(false, { app: true })}`),
    );
    for (const [name, value] of Object.entries(directAuthHeaders())) {
      xhr.setRequestHeader(name, value);
    }
    for (const [name, value] of csrfHeaders) {
      xhr.setRequestHeader(name, value);
    }
    // Both headers or neither: the server tracks a transfer only when it can
    // name the window to route frames to AND the transfer to echo back.
    if (opts.transferId) {
      xhr.setRequestHeader("x-chan-window-id", sessionWindowId());
      xhr.setRequestHeader("x-chan-transfer-id", opts.transferId);
    }
    xhr.upload.onprogress = (event) => {
      opts.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null,
        lengthComputable: event.lengthComputable,
      });
    };
    xhr.onload = () => {
      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        responseText: xhr.responseText,
        // Read only on the admission refusal, which is the only status that
        // carries it. The optional call keeps a response object that does not
        // model headers from throwing in here, where a throw would strand the
        // promise instead of failing the request.
        retryAfterSeconds:
          xhr.status === 503
            ? parseRetryAfterSeconds(xhr.getResponseHeader?.("retry-after") ?? null)
            : null,
      });
    };
    xhr.onerror = () => reject(new ApiError(xhr.status || 0, "upload failed"));
    xhr.onabort = () => {
      const err = new Error("upload cancelled");
      err.name = "AbortError";
      reject(err);
    };
    const abort = () => xhr.abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => opts.signal?.removeEventListener("abort", abort);
    if (opts.signal?.aborted) {
      xhr.abort();
      return;
    }
    xhr.send(form);
  });
}

async function uploadMultipart(
  form: FormData,
  opts: UploadProgressOptions,
): Promise<{ path: string; size: number }> {
  const response = await withGatewayCsrfRetry("POST", (csrfHeaders) =>
    uploadXhrAttempt(form, opts, csrfHeaders),
  );
  if (response.status === 503) {
    // The admission bound, not a failure: refused before any body was read, so
    // nothing was transferred and no admission was consumed.
    throw new ApiError(503, "server busy", {
      retryAfterSeconds: response.retryAfterSeconds,
    } satisfies TransferBusyDetail);
  }
  if (response.status < 200 || response.status >= 300) {
    xhrTextError(response.status, response.statusText, response.responseText);
  }
  return JSON.parse(response.responseText) as { path: string; size: number };
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const match = /filename="([^"]+)"/i.exec(value) ?? /filename=([^;]+)/i.exec(value);
  return match?.[1]?.trim() || null;
}

function numericHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

type FileStreamMeta = Omit<FileResponse, "content"> & { size?: number };

export type FileReadStreamProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type FileReadStreamOptions = {
  signal?: AbortSignal;
  onMeta?: (meta: FileStreamMeta) => void;
  onChunk?: (chunk: string, progress: FileReadStreamProgress) => void;
};

export type ReportFileStreamEvent =
  | { type: "meta"; path: string }
  | { type: "report"; stats: ReportFileStats }
  | { type: "missing" }
  | { type: "done" }
  | { type: "error"; error: string };

export type BacklinksStreamEvent =
  | { type: "meta"; path: string }
  | { type: "edge"; edge: GraphEdge }
  | { type: "done" }
  | { type: "error"; error: string };

export type GraphStreamEvent =
  | {
      type: "meta";
      scope: "workspace" | "directory" | "file";
      path: string;
      depth: number;
    }
  | { type: "nodes"; nodes: GraphViewNode[] }
  | { type: "edges"; edges: GraphViewEdge[] }
  | { type: "done" }
  | { type: "error"; error: string };

type ReportFileStreamOptions = {
  signal?: AbortSignal;
  onMeta?: (path: string) => void;
  onReport?: (stats: ReportFileStats) => void;
  onMissing?: () => void;
  onDone?: () => void;
};

type BacklinksStreamOptions = {
  signal?: AbortSignal;
  onMeta?: (path: string) => void;
  onEdge?: (edge: GraphEdge) => void;
  onDone?: () => void;
};

type GraphStreamOptions = {
  signal?: AbortSignal;
  onMeta?: (meta: Extract<GraphStreamEvent, { type: "meta" }>) => void;
  onNodes?: (nodes: GraphViewNode[], view: GraphView) => void;
  onEdges?: (edges: GraphViewEdge[], view: GraphView) => void;
  onDone?: (view: GraphView) => void;
};

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  throw new Error("invalid file stream event");
}

async function readNdjsonStream<TEvent>(
  path: string,
  opts: {
    signal?: AbortSignal;
    onEvent: (event: TEvent) => void;
  },
): Promise<void> {
  const res = await chanFetch(apiPath(path), {
    method: "GET",
    headers: directAuthHeaders(),
    signal: opts.signal,
  });
  if (!res.ok) {
    await responseTextError(res);
  }
  if (!res.body) {
    throw new Error("streaming response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    opts.onEvent(recordValue(JSON.parse(trimmed)) as TEvent);
  };

  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl < 0) break;
      processLine(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) processLine(buffered);
}

async function readFileStream(
  path: string,
  opts: FileReadStreamOptions = {},
): Promise<FileResponse> {
  const headers = directAuthHeaders();
  const res = await chanFetch(apiPath(`/api/files/${encPath(path)}?stream=1`), {
    method: "GET",
    headers,
    signal: opts.signal,
  });
  if (!res.ok) {
    await responseTextError(res);
  }
  if (!res.body) {
    throw new Error("streaming response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";
  let meta: FileStreamMeta = { path, mtime: null, mtime_ns: null, writable: true };
  let done = false;
  let loadedBytes = 0;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = recordValue(JSON.parse(trimmed));
    const type = event.type;
    if (type === "meta") {
      const nextMeta: FileStreamMeta = {
        path: typeof event.path === "string" ? event.path : path,
        mtime: typeof event.mtime === "number" ? event.mtime : null,
        mtime_ns: typeof event.mtime_ns === "string" ? event.mtime_ns : null,
        authority_version:
          typeof event.authority_version === "number" ? event.authority_version : null,
        disk_conflicted:
          typeof event.disk_conflicted === "boolean" ? event.disk_conflicted : false,
        path_class: event.path_class as FileResponse["path_class"],
        writable: typeof event.writable === "boolean" ? event.writable : true,
        size: typeof event.size === "number" ? event.size : undefined,
      };
      meta = nextMeta;
      opts.onMeta?.(nextMeta);
      return;
    }
    if (type === "chunk") {
      const chunk = typeof event.content === "string" ? event.content : "";
      content += chunk;
      loadedBytes +=
        typeof event.bytes === "number" ? event.bytes : chunk.length;
      opts.onChunk?.(chunk, {
        loadedBytes,
        totalBytes: meta.size ?? null,
      });
      return;
    }
    if (type === "done") {
      done = true;
      return;
    }
    if (type === "error") {
      throw new ApiError(0, String(event.error ?? "file stream failed"));
    }
    throw new Error(`unknown file stream event: ${String(type)}`);
  };

  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl < 0) break;
      processLine(buffered.slice(0, nl));
      buffered = buffered.slice(nl + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) processLine(buffered);
  if (!done) throw new Error("file stream ended before done");
  return {
    path: meta.path,
    content,
    mtime: meta.mtime ?? null,
    mtime_ns: meta.mtime_ns ?? null,
    authority_version: meta.authority_version ?? null,
    disk_conflicted: meta.disk_conflicted ?? false,
    path_class: meta.path_class,
    writable: meta.writable ?? true,
  };
}

export const api = {
  workspace: () => req<WorkspaceInfo>("GET", "/api/workspace"),
  /// Read the global per-user config (registry of known workspaces,
  /// default-workspace path, preferences). Mounted by the Settings UI.
  config: () => req<GlobalConfig>("GET", "/api/config"),
  /// Apply one owner-specific partial preferences update.
  updateConfig: (body: ConfigPatchRequest) =>
    req<GlobalConfig>("PATCH", "/api/config", body),
  /** Upload an image attachment. Multipart POST that the editor's `![`
   *  picker, drag-and-drop, and clipboard paste all funnel through.
   *  Returns the workspace-relative path of the saved file.
   *
   *  `dir` is the workspace-relative directory to save into. The editor
   *  passes the directory of the file being edited so uploads land
   *  next to it (markdown can then reference the file with `./name`).
   *  Null falls back to the server's configured `attachments_dir`. */
  uploadAttachment: async (
    file: File,
    dir: string | null = null,
  ): Promise<{ path: string }> => {
    // Multipart upload skips the JSON-shaped request() helper because
    // FormData cannot be JSON-encoded; we hit fetch directly and
    // reuse the same auth token.
    const form = new FormData();
    form.append("file", file);
    if (dir !== null) form.append("dir", dir);
    const headers = directAuthHeaders();
    const res = await chanFetch(apiPath(`/api/attachments${filesMutationSuffix(false)}`), {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      await responseTextError(res);
    }
    return (await res.json()) as { path: string };
  },
  /** Import contacts from a CSV. Multipart POST mirroring
   *  uploadAttachment: server runs the parser, drops one
   *  `chan.kind: contact` markdown note per contact under
   *  `destDir`, and returns a per-row outcome breakdown. The
   *  wizard surfaces these counts to the user. */
  importContacts: async (
    file: File,
    destDir: string,
    opts: { provider?: string; overwrite?: boolean } = {},
  ): Promise<{
    wrote: string[];
    overwrote: string[];
    skipped: Array<{ path: string; reason: string }>;
    failed: Array<{ name: string; reason: string }>;
    /** Non-fatal issues the server detected while parsing the
     *  request (e.g., unknown multipart parts that were ignored).
     *  Always present; empty when nothing unexpected showed up. */
    warnings: string[];
  }> => {
    const form = new FormData();
    form.append("file", file);
    form.append("dest_dir", destDir);
    form.append("provider", opts.provider ?? "google");
    form.append("overwrite", opts.overwrite ? "true" : "false");
    const headers = directAuthHeaders();
    const res = await chanFetch(apiPath("/api/contacts/import"), {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      await responseTextError(res);
    }
    const body = (await res.json()) as {
      wrote: string[];
      overwrote: string[];
      skipped: Array<{ path: string; reason: string }>;
      failed: Array<{ name: string; reason: string }>;
      warnings?: string[];
    };
    // `warnings` was added after the initial route shipped; tolerate
    // older servers that don't send it by defaulting to empty.
    return { ...body, warnings: body.warnings ?? [] };
  },
  metadataExport: async (): Promise<MetadataExportDownload> => {
    const res = await chanFetch(apiPath("/api/metadata/export"), {
      method: "POST",
      headers: directAuthHeaders(),
    });
    if (!res.ok) {
      await responseTextError(res);
    }
    return {
      blob: await res.blob(),
      filename:
        contentDispositionFilename(res.headers.get("content-disposition")) ??
        "chan-metadata.tar.zst",
      files: numericHeader(res, "x-chan-metadata-files"),
      bytes: numericHeader(res, "x-chan-metadata-bytes"),
    };
  },
  metadataImport: async (
    file: File,
    opts: { rescan?: boolean; forceScm?: boolean } = {},
  ): Promise<MetadataImportReport> => {
    const form = new FormData();
    form.append("file", file);
    form.append("rescan", opts.rescan === false ? "false" : "true");
    form.append("force_scm", opts.forceScm ? "true" : "false");
    const res = await chanFetch(apiPath("/api/metadata/import"), {
      method: "POST",
      headers: directAuthHeaders(),
      body: form,
    });
    if (!res.ok) {
      await responseTextError(res);
    }
    return (await res.json()) as MetadataImportReport;
  },
  /** List contact-kind notes for the editor `@` picker. Optional
   *  `q` is a case-insensitive substring filter against the
   *  contact's title, basename, AND any of its email addresses
   *  (so typing `alice` matches both "Alice Anderson" and a
   *  contact whose only `alice` is in `alice@example.com`); empty
   *  string returns the alphabetical head of the catalog. The
   *  returned `emails` is the contact's full address list, used
   *  by the picker to render a secondary line under the name. */
  contacts: (q = "", limit = 10) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("limit", String(limit));
    return req<
      Array<{
        path: string;
        label: string;
        emails?: string[];
        /// `aliases:` array from the contact note's frontmatter
        /// (top-level, Obsidian convention). Empty when the contact
        /// has no alternate names. The mention `@@` trigger uses
        /// this to commit `@@<alias>` and the resolver maps any
        /// alias back to the contact file.
        aliases?: string[];
      }>
    >("GET", `/api/contacts?${qs.toString()}`);
  },
  /// Mention-corpus prefix lookup. Returns the
  /// distinct `@@<Name>` tokens observed across the indexed
  /// markdown corpus, NOT just the contact files. The bubble
  /// merges these with `api.contacts` results so a name that
  /// has many `@@<Name>` references in body text but no contact
  /// file still surfaces in the completion dropdown.
  ///
  /// Backed by the `GET /api/mentions?q=<prefix>&limit=<int>`
  /// route. Labels arrive WITH the `@@` sigil (the route composes it).
  /// Empty `q` returns the full corpus capped at `limit` (default 10).
  mentions: (q = "", limit = 10) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("limit", String(limit));
    return req<Array<{ label: string }>>(
      "GET",
      `/api/mentions?${qs.toString()}`,
    );
  },
  list: (dir?: string | null) => {
    const qs = new URLSearchParams();
    if (dir !== undefined && dir !== null) qs.set("dir", dir);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return req<TreeEntry[]>("GET", `/api/files${suffix}`);
  },
  read: (path: string) => req<FileResponse>("GET", `/api/files/${encPath(path)}`),
  readStream: readFileStream,
  resolveSessionConflict: (
    path: string,
    action: "reload" | "overwrite",
  ) =>
    req<FileResponse>("POST", "/api/session-conflicts/resolve", {
      path,
      action,
    }),
  /// Persist raw UTF-8 text progressively. A changed write under a
  /// live authority requires both its open-time mtime and authority
  /// version; stale values reject with structured retry metadata.
  write: async (
    path: string,
    content: string,
    expectedMtimeNs?: string | null,
    expectedMtime?: number | null,
    authorityVersion?: number | null,
  ): Promise<FileWriteResponse> => {
    const params = new URLSearchParams();
    if (expectedMtimeNs !== undefined && expectedMtimeNs !== null) {
      params.set("expected_mtime_ns", expectedMtimeNs);
    } else if (expectedMtime !== undefined && expectedMtime !== null) {
      params.set("expected_mtime", String(expectedMtime));
    }
    if (authorityVersion !== undefined && authorityVersion !== null) {
      params.set("authority_version", String(authorityVersion));
    }
    if (isFilesWindow()) params.set("w", sessionWindowId());
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const headers = {
      ...directAuthHeaders(),
      "content-type": "text/plain; charset=utf-8",
    };
    const res = await chanFetch(apiPath(`/api/files/${encPath(path)}${suffix}`), {
      method: "PUT",
      headers,
      body: content,
    });
    if (!res.ok) await responseTextError(res);
    return (await res.json()) as FileWriteResponse;
  },
  create: (path: string, isDir: boolean, content?: string) =>
    req<void>("POST", `/api/files${filesMutationSuffix(false)}`, {
      path,
      is_dir: isDir,
      content,
    }),
  uploadFile: (
    file: File,
    dir: string,
    opts: UploadProgressOptions = {},
  ): Promise<{ path: string; size: number }> => {
    const form = new FormData();
    form.append("dir", dir);
    form.append("file", file);
    return uploadMultipart(form, opts);
  },
  replaceFile: (
    file: File,
    path: string,
    opts: UploadProgressOptions = {},
  ): Promise<{ path: string; size: number }> => {
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    return uploadMultipart(form, opts);
  },
  /// Create a new draft directory with a seeded draft.md via
  /// /api/drafts/new. Picks the next `untitled` / `untitled-N`
  /// name server-side. Returns the real in-workspace relpath
  /// `<draftsDir>/<name>/draft.md` which the SPA opens via
  /// the existing /api/files/* GET path. An optional `kind` picks the
  /// seed content: no body seeds the plain markdown draft, `"slides"`
  /// seeds the canonical slides frontmatter; the route 400s any other
  /// kind.
  createDraft: (kind?: "slides") =>
    req<{ path: string; name: string }>(
      "POST",
      "/api/drafts/new",
      kind ? { kind } : undefined,
    ),
  /// Create a new diagram draft with a seeded `<name>.excalidraw` scene
  /// via /api/diagrams/new. Same response shape as createDraft; the SPA
  /// opens the returned path in canvas mode via isExcalidraw.
  createDiagram: () =>
    req<{ path: string; name: string }>("POST", "/api/diagrams/new"),
  inspectDraft: (path: string) =>
    req<DraftInspectResponse>("POST", "/api/drafts/inspect", { path }),
  discardDraft: (path: string) =>
    req<void>("POST", "/api/drafts/discard", { path }),
  promoteDraft: (path: string, target: string) =>
    req<DraftPromoteResponse>("POST", "/api/drafts/promote", { path, target }),
  remove: (path: string) =>
    req<void>("DELETE", `/api/files/${encPath(path)}${filesMutationSuffix(false)}`),
  downloadUrl: (path: string) => withTokenQuery(`/api/files/${encPath(path)}?download=1`),
  move: (from: string, to: string) =>
    req<MoveResponse>("POST", `/api/move${filesMutationSuffix(false)}`, { from, to }),
  /// Multi-entry move/copy for the File Browser clipboard + multi-drag.
  /// `op` move = cut/paste + drag (rename + link rewrite per source);
  /// copy = copy/paste (duplicate). Collisions resolve to a " copy"
  /// suffix server-side; a move into a source's own parent is skipped.
  fsTransfer: (op: TransferOp, sources: string[], destDir: string) =>
    req<TransferResponse>("POST", `/api/fs/transfer${filesMutationSuffix(false)}`, {
      op,
      sources,
      dest_dir: destDir,
    }),
  /// Exact-basename lookup for missing-file reopen recovery.
  search: (q: string, limit = 10) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return req<SearchHit[]>("GET", `/api/search/files?${params}`);
  },
  /// Wiki-link target search. Unlike the recovery-only /api/search/files, this is
  /// backed by the graph and matches file basename, indexed title,
  /// and heading text. Wiki file mode consumes both row kinds:
  /// file rows insert paths; heading rows insert anchored links.
  linkTargets: (q: string, limit = 10) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    return req<LinkTarget[]>("GET", `/api/link-targets?${params}`);
  },
  /// Hybrid (BM25 + dense) content search. The backend silently
  /// picks hybrid (or BM25 when built without the `embeddings`
  /// feature); the previous user-facing mode picker was removed in
  /// favour of a single sensible default.
  searchContent: async (q: string, opts: { limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    return readContentSearch(
      await req<ContentSearchResponse>(
        "GET",
        `/api/search/content?${params.toString()}`,
      ),
    );
  },
  /// Headings of a single file. The wiki-link bubble fetches this
  /// when the user types `#` after a resolved file target so
  /// suggestions filter against the file's outline.
  headings: (path: string) =>
    req<HeadingRow[]>("GET", `/api/headings/${encPath(path)}`),
  /// Incoming link edges (other files that link to `path`). Used by
  /// the editor's bottom-right status bar to show a backlink count;
  /// `.length` is enough for the count, but the full edge list is
  /// available for future "linked from" panels.
  backlinks: (path: string) =>
    req<GraphEdge[]>("GET", `/api/backlinks/${encPath(path)}`),
  backlinksStream: async (
    path: string,
    opts: BacklinksStreamOptions = {},
  ): Promise<GraphEdge[]> => {
    const edges: GraphEdge[] = [];
    let done = false;
    await readNdjsonStream<BacklinksStreamEvent>(
      `/api/backlinks/${encPath(path)}?stream=1`,
      {
        signal: opts.signal,
        onEvent(event) {
          if (event.type === "meta") {
            opts.onMeta?.(event.path);
            return;
          }
          if (event.type === "edge") {
            edges.push(event.edge);
            opts.onEdge?.(event.edge);
            return;
          }
          if (event.type === "done") {
            done = true;
            opts.onDone?.();
            return;
          }
          if (event.type === "error") {
            throw new ApiError(0, event.error);
          }
          throw new Error(`unknown backlinks stream event: ${String((event as { type?: unknown }).type)}`);
        },
      },
    );
    if (!done) throw new Error("backlinks stream ended before done");
    return edges;
  },
  /// chan-report per-file stats: language, SLOC, comments, blanks,
  /// complexity. 404 when the path isn't in the index (binary file,
  /// gitignored, or unknown language); callers treat that as
  /// "no report for this file" rather than an error.
  reportFile: (path: string) =>
    req<ReportFileStats>(
      "GET",
      `/api/report/file?path=${encodeURIComponent(path)}`,
    ),
  reportFileStream: async (
    path: string,
    opts: ReportFileStreamOptions = {},
  ): Promise<ReportFileStats | null> => {
    let stats: ReportFileStats | null = null;
    let done = false;
    await readNdjsonStream<ReportFileStreamEvent>(
      `/api/report/file?path=${encodeURIComponent(path)}&stream=1`,
      {
        signal: opts.signal,
        onEvent(event) {
          if (event.type === "meta") {
            opts.onMeta?.(event.path);
            return;
          }
          if (event.type === "report") {
            stats = event.stats;
            opts.onReport?.(event.stats);
            return;
          }
          if (event.type === "missing") {
            stats = null;
            opts.onMissing?.();
            return;
          }
          if (event.type === "done") {
            done = true;
            opts.onDone?.();
            return;
          }
          if (event.type === "error") {
            throw new ApiError(0, event.error);
          }
          throw new Error(`unknown report stream event: ${String((event as { type?: unknown }).type)}`);
        },
      },
    );
    if (!done) throw new Error("report stream ended before done");
    return stats;
  },
  /// chan-report directory roll-up: totals, by-language, and COCOMO.
  /// Empty `path` returns the whole-workspace roll-up. The per-file
  /// array is dropped server-side; only the summary fields come
  /// back so big directories stay cheap to fetch.
  reportPrefix: (path: string) =>
    req<ReportPrefix>(
      "GET",
      `/api/report/prefix?path=${encodeURIComponent(path)}`,
    ),
  /// Per-directory roll-up via the O(1) maintained cache. Same
  /// response shape as `reportPrefix` but avoids a full file-map
  /// walk. Empty `path` returns the workspace root. 404 when the
  /// directory has no tracked files (caller treats null as "no
  /// report yet").
  reportDir: (path: string) =>
    req<ReportPrefix>(
      "GET",
      `/api/report/dir?path=${encodeURIComponent(path)}`,
    ),
  /// Resolve a wiki / markdown link target to the actual workspace file
  /// + node kind. `target` is the path portion of the link (no
  /// `#anchor`); pass through path-encoded segments verbatim. The
  /// server returns 404 when no file matches any of the
  /// `path.md` / `path.txt` / `path` probes, so the client treats a
  /// missing resolve as "broken link" rather than an error.
  /// `kind` distinguishes contact-kind notes from generic docs so
  /// the editor can stamp `data-refkind` and render a kind-aware
  /// pill without re-parsing the target's frontmatter.
  resolveLink: (target: string) =>
    req<{
      path: string;
      anchor?: string;
      kind: "file" | "contact";
      /// True when `path` is a directory: the caller opens the file
      /// browser at that folder instead of the text editor.
      is_dir?: boolean;
    }>("GET", `/api/resolve-link?target=${encodeURIComponent(target)}`),
  indexStatus: async () =>
    readIndexStatus(await req<IndexStatusWire>("GET", "/api/index/status")),
  indexingState: () => req<IndexingStateResponse>("GET", "/api/indexing/state"),
  health: () => req<HealthResponse>("GET", "/api/health"),
  inspector: (path: string) =>
    req<InspectorPayload>(
      "GET",
      `/api/inspector?path=${encodeURIComponent(path)}`,
    ),
  /// Wipe and rebuild the search index from scratch. Returns when
  /// the rebuild has been kicked off; status moves through
  /// "building" via /api/index/status as files are reprocessed.
  indexRebuild: () => req<void>("POST", "/api/index/rebuild"),
  /// Compile-time identity (chan version + cargo features). Used by
  /// the Settings "About" footer.
  buildInfo: () => req<BuildInfo>("GET", "/api/build-info"),
  /// Ready local extensions for this process. The catalog is served to any
  /// authenticated client; over the gateway tunnel, non-owner participants
  /// get read-only proxy access (mutations 403) via the server-side
  /// require_local_mutation layer.
  extensions: () => req<ExtensionInfo[]>("GET", "/api/extensions"),
  /// Reset the workspace at one of three escalating levels. After a
  /// successful reset the caller should reload the window so cached
  /// workspace info, file tree, and tabs resync; the server has done
  /// the work but in-app state still references the pre-reset world.
  storageReset: (mode: ResetMode) =>
    req<ResetResponse>("POST", "/api/storage/reset", { mode }),
  /// Files-mode boot context: the filesystem root, the wire-relative
  /// canonical home the browser starts in, and the path grammar. Served
  /// only by tenants that construct the standalone Files state.
  fsContext: () => req<FsContext>("GET", "/api/fs/context"),
  /// Read the persisted session payload. Server keys by `?w=<id>`;
  /// chan-desktop windows pass their unique window label in the page URL,
  /// while normal browser tabs use `default`. Returns `null` when none exists yet
  /// (server returns 204 → req() yields undefined → coerced to
  /// null for the caller's convenience).
  getSession: async (): Promise<unknown | null> => {
    const v = await req<unknown | undefined>("GET", sessionPath());
    return v ?? null;
  },
  /// Persist the session payload. Body shape is opaque to the
  /// server; the frontend sends `serializeLayout()` output.
  putSession: (body: unknown) =>
    req<void>("PUT", sessionPath(), body),
  /// Delete this window's persisted session blob. Called when the
  /// window has no real content (layout serializes to null) so it
  /// stops being reported as a `saved` window by `/api/windows` /
  /// `cs window list`, instead of leaving an empty blob behind.
  /// Idempotent on the server (missing key → 204).
  deleteSession: () => req<void>("DELETE", sessionPath()),
  links: () => req<GraphSnapshot>("GET", "/api/links"),
  /// Typed graph payload powering the graph view tab.
  graph: (opts: { scope?: "workspace" | "directory" | "file"; path?: string; depth?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.path) params.set("path", opts.path);
    if (opts.depth !== undefined) params.set("depth", String(opts.depth));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return req<GraphView>("GET", `/api/graph${suffix}`);
  },
  graphStream: async (
    opts: { scope?: "workspace" | "directory" | "file"; path?: string; depth?: number } = {},
    streamOpts: GraphStreamOptions = {},
  ): Promise<GraphView> => {
    const params = new URLSearchParams();
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.path) params.set("path", opts.path);
    if (opts.depth !== undefined) params.set("depth", String(opts.depth));
    params.set("stream", "1");
    const nodesById = new Map<string, GraphViewNode>();
    const edgesByKey = new Map<string, GraphViewEdge>();
    let done = false;
    const view = (): GraphView => ({
      nodes: [...nodesById.values()],
      edges: [...edgesByKey.values()],
    });
    const edgeKey = (e: GraphViewEdge): string =>
      `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.rank ?? ""}`;
    await readNdjsonStream<GraphStreamEvent>(
      `/api/graph?${params.toString()}`,
      {
        signal: streamOpts.signal,
        onEvent(event) {
          if (event.type === "meta") {
            streamOpts.onMeta?.(event);
            return;
          }
          if (event.type === "nodes") {
            for (const node of event.nodes) nodesById.set(node.id, node);
            streamOpts.onNodes?.(event.nodes, view());
            return;
          }
          if (event.type === "edges") {
            for (const edge of event.edges) edgesByKey.set(edgeKey(edge), edge);
            streamOpts.onEdges?.(event.edges, view());
            return;
          }
          if (event.type === "done") {
            done = true;
            streamOpts.onDone?.(view());
            return;
          }
          if (event.type === "error") {
            throw new ApiError(0, event.error);
          }
          throw new Error(`unknown graph stream event: ${String((event as { type?: unknown }).type)}`);
        },
      },
    );
    if (!done) throw new Error("graph stream ended before done");
    return view();
  },
  /// Language graph payload: language nodes connected to directory nodes.
  languageGraph: (opts: { depth?: number; language?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.depth !== undefined) params.set("depth", String(opts.depth));
    if (opts.language) params.set("language", opts.language);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return req<LanguageGraphResponse>("GET", `/api/graph/languages${suffix}`);
  },
  /// Filesystem graph payload: directories, files, symlinks, hardlinks,
  /// and ghost nodes. Distinct from the semantic markdown graph.
  // `limit` / `cursor` opt into cursor-paged delivery: the server returns
  // a bounded batch plus a `cursor` to fetch the next, so a large scope
  // fills in gradually instead of arriving as one blocking payload. Both
  // absent = the whole-scope response (byte-identical to before).
  fsGraph: (opts: {
    scope: "file" | "directory";
    path: string;
    depth?: number;
    limit?: number;
    cursor?: string;
  }) =>
    req<FsGraphResponse>(
      "GET",
      `/api/fs-graph?scope=${encodeURIComponent(opts.scope)}&path=${encodeURIComponent(opts.path)}&depth=${encodeURIComponent(String(opts.depth ?? 1))}` +
        (opts.limit !== undefined ? `&limit=${encodeURIComponent(String(opts.limit))}` : "") +
        (opts.cursor !== undefined ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""),
    ),
  // New-workspace pre-flight: poll the readiness snapshot and submit the
  // user's decision for a blocking step (e.g. download the embedding model
  // vs keyword-only search).
  preflight: () => req<PreflightSnapshot>("GET", "/api/preflight"),
  preflightDecision: (body: PreflightDecisionRequest) =>
    req<PreflightSnapshot>("POST", "/api/preflight/decision", body),
  // Non-blocking: create the `cs` terminal alias when it is missing from the
  // host's PATH (the pre-flight snapshot's `cs_link` offer).
  createCsLink: () => req<CsLinkResult>("POST", "/api/preflight/cs-link"),
  /// Next per-tenant default terminal name (`Terminal-1`, `Terminal-2`, ...).
  /// Backed by an atomic counter on the per-tenant terminal registry, so
  /// numbering stays consistent across every window of the tenant: all
  /// standalone terminal windows (one shared tenant), or all windows of a
  /// workspace (that workspace's tenant). A per-window count would restart at
  /// 1 in each new window. The route returns a PLAIN-TEXT body, not JSON, so
  /// we hit fetch directly and read `.text()` rather than the JSON `req()`.
  terminalNextName: async (): Promise<string> => {
    const res = await chanFetch(apiPath("/api/terminal/next-name"), {
      method: "GET",
      headers: directAuthHeaders(),
    });
    if (!res.ok) {
      await responseTextError(res);
    }
    return (await res.text()).trim();
  },
  /// One-shot snapshot of the cross-window terminal roster, for seeding the
  /// SPA's roster on `/ws` (re)connect. Live updates then arrive as
  /// `terminal_roster` frames over `/ws`; this closes the reconnect gap where
  /// a window would miss the last push. Empty on the failure path so a missing
  /// route (older server) degrades to local-only broadcast targets.
  terminalRoster: async (): Promise<TerminalRosterEntry[]> => {
    const res = await req<{ sessions?: TerminalRosterEntry[] }>(
      "GET",
      "/api/terminals/roster",
    );
    return res.sessions ?? [];
  },
  spawnTerminal: (body: TerminalSpawnRequest) =>
    req<TerminalSpawnResponse>("POST", "/api/terminals", body),
  restartTerminal: (sessionId: string, body?: TerminalRestartRequest) =>
    req<void>("POST", `/api/terminals/${encodeURIComponent(sessionId)}/restart`, body),
  closeTerminal: (sessionId: string) =>
    req<void>("DELETE", `/api/terminals/${encodeURIComponent(sessionId)}`),
  /// Set a terminal's broadcast toggle from another window. The server routes
  /// a `terminal_broadcast` window-command to the session's owning window,
  /// which flips its tab (re-syncing the flag + lighting the sign). Backs the
  /// broadcast menu's group-wide Select All / per-row toggles for terminals
  /// the local window does not host.
  setTerminalSessionBroadcast: (sessionId: string, on: boolean) =>
    req<void>(
      "POST",
      `/api/terminals/${encodeURIComponent(sessionId)}/broadcast`,
      { on },
    ),
  setBubbleOverlayMode: (mode: BubbleOverlayMode): Promise<void> =>
    updateGlobalConfigSerial((p) =>
      p.bubble_overlay_mode === mode ? null : { bubble_overlay_mode: mode },
    ),
  setEmptyPaneCarouselCycling: (cycling: boolean): Promise<void> =>
    updateGlobalConfigSerial((p) =>
      p.empty_pane_carousel_cycling === cycling
        ? null
        : { empty_pane_carousel_cycling: cycling },
    ),
  /// Persist the per-library page-width cap ratio. The SPA applies the
  /// cap optimistically and debounces this write (the width slider
  /// fires on every drag tick); the value is stored verbatim and
  /// re-clamped on read. Serialized through the shared helper so a concurrent
  /// overlay / cs-dismiss flip can't clobber it.
  setPageWidthRatio: (ratio: number): Promise<void> =>
    updateGlobalConfigSerial((p) =>
      p.page_width_ratio === ratio ? null : { page_width_ratio: ratio },
    ),
  /// Persist the per-library overlay-maximize toggle.
  setOverlayMaximizedPref: (on: boolean): Promise<void> =>
    updateGlobalConfigSerial((p) =>
      p.overlay_maximized === on ? null : { overlay_maximized: on },
    ),
  /// Persist the per-library `cs` terminal-alias offer dismissal.
  setCsDismissed: (on: boolean): Promise<void> =>
    updateGlobalConfigSerial((p) =>
      p.cs_dismissed === on ? null : { cs_dismissed: on },
    ),
  /// Semantic-search endpoints. Open-read for state; settings-
  /// gated for mutations (download / enable / disable). The
  /// download POST blocks until the resolver has the bytes on
  /// disk. The Settings UI polls `/state` in parallel to detect
  /// the `model_present` transition without per-byte progress.
  semanticState: () => req<SemanticState>("GET", "/api/index/semantic/state"),
  semanticModels: () =>
    req<SemanticModelRegistry>("GET", "/api/index/semantic/models"),
  semanticModelPatch: (model: string) =>
    req<SemanticState>("PATCH", "/api/index/semantic/model", { model }),
  semanticDownload: () => req<SemanticState>("POST", "/api/index/semantic/download"),
  semanticEnable: () => req<SemanticState>("POST", "/api/index/semantic/enable"),
  semanticDisable: () => req<SemanticState>("POST", "/api/index/semantic/disable"),
  /// Per-workspace chan-reports toggle. Mirrors the
  /// semantic-toggle shape (state / enable / disable). Backed by
  /// `crates/chan-server/src/routes/reports_toggle.rs`. The
  /// `enable` call triggers an incremental indexing pass;
  /// `disable` is idempotent at the chan-workspace layer.
  reportsState: () =>
    req<{ enabled: boolean }>("GET", "/api/index/reports/state"),
  reportsEnable: () =>
    req<{ enabled: boolean }>("POST", "/api/index/reports/enable"),
  reportsDisable: () =>
    req<{ enabled: boolean }>("POST", "/api/index/reports/disable"),
  /// Per-workspace directory blocklist. The index +
  /// graph walk skips `effective = union(defaults, workspace)`; only the
  /// `workspace` additions are editable. PUT replaces the whole set
  /// (names only - case-insensitive basenames, no paths) and queues a
  /// re-walk. Backed by
  /// `crates/chan-server/src/routes/excluded_dirs.rs`.
  excludedDirs: () => req<ExcludedDirsView>("GET", "/api/index/excluded-dirs"),
  setExcludedDirs: (workspace: string[]) =>
    req<ExcludedDirsView>("PUT", "/api/index/excluded-dirs", { workspace }),
  /// Screensaver state and PIN endpoints
  /// (`crates/chan-server/src/routes/screensaver.rs`). The PIN
  /// hash never appears in the response body; the state shape
  /// carries `pin_set: bool` instead, and `verify` returns a
  /// single `verified: bool` from a server-side constant-time
  /// compare. PBKDF2 happens client-side via
  /// `state/screensaver.ts::hashPin`; payload field
  /// `{ hash: base64 }`.
  screensaverState: () =>
    req<{ enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean }>(
      "GET",
      "/api/screensaver/state",
    ),
  screensaverPatch: (body: {
    enabled?: boolean;
    timeout_secs?: number;
    theme?: "plain" | "matrix";
  }) =>
    req<{ enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean }>(
      "PATCH",
      "/api/screensaver/state",
      body,
    ),
  screensaverSetPin: (hash_b64: string) =>
    req<{ enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean }>(
      "POST",
      "/api/screensaver/pin",
      { hash: hash_b64 },
    ),
  screensaverClearPin: () =>
    req<{ enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean }>(
      "DELETE",
      "/api/screensaver/pin",
    ),
  screensaverVerify: (hash_b64: string) =>
    req<{ verified: boolean }>(
      "POST",
      "/api/screensaver/verify",
      { hash: hash_b64 },
    ),
  /// Dir-based team-config read/write backing the Team Work dialog's
  /// New/Load flow. The config lives INSIDE the workspace under a
  /// workspace-relative `{dir}/config.toml`, written through the
  /// Workspace sandbox (atomic, path-sandboxed, special-file refusal);
  /// the backend also generates `{dir}/bootstrap.md` and the team's
  /// tasks/journals/followups dirs on write
  /// (see crates/chan-server/src/routes/team_config.rs).
  /// `readTeamConfig` backs the Load auto-validate (400 on
  /// missing / invalid TOML); `writeTeamConfig` re-saves the
  /// (possibly edited) config on Bootstrap.
  readTeamConfig: (dir: string) =>
    req<TeamConfigWire>("POST", "/api/team-config/read", { dir }),
  /// `briefContent`, when set, is folded VERBATIM into the generated
  /// bootstrap.md server-side (its own section after the Roster). It is the
  /// brief TEXT, not a path (the server has no client filesystem); the dialog
  /// reads the file client-side, mirroring the CLI's `--brief`. It is not part
  /// of config.toml, so it travels as a sibling field.
  writeTeamConfig: (dir: string, config: TeamConfigWire, briefContent?: string) =>
    req<void>("POST", "/api/team-config/write", {
      dir,
      config,
      brief_content: briefContent,
    }),

  /// Reply to a survey raised by `cs terminal survey`. The blocked CLI is
  /// awaiting on the server's survey bus keyed by `surveyId`; this POST
  /// completes that oneshot so the CLI prints the result and exits.
  surveyReply: (reply: SurveyReplyRequest) =>
    req<void>("POST", "/api/survey/reply", reply),

  /// Reply to a `cs session handover`: the leader accepts or rejects a parked
  /// request. Fires the handover-bus oneshot and unblocks the requesting CLI.
  /// 404 if it already resolved (timed out / taken over); 403 if this window is
  /// not the current leader.
  sessionHandoverReply: (reply: SessionHandoverReplyRequest) =>
    req<void>("POST", "/api/session/handover/reply", reply),

  /// Reply to a `cs pane` window query. The server pushed a `pane_query`
  /// window_command with a minted `requestId`; the SPA built the layout
  /// snapshot and POSTs it here, which completes the parked window-bus
  /// oneshot and unblocks the waiting CLI. 404 if the request already
  /// timed out / was answered (caller ignores it: a query has no UI).
  windowReply: (reply: WindowReplyRequest) =>
    req<void>("POST", "/api/window/reply", reply),

  /// Command-launcher Open: queue `cs open` semantics for `target` in the
  /// given window (Contract C, `POST /api/open`). The resulting
  /// open_browser / open_file / open_graph_link window command rides /ws
  /// back to that window; the response `message` is just the queued ack. A
  /// refusal (binary target, workspace escape, no connected window)
  /// rejects with the server's 400 `{error}` as the ApiError message.
  open: (request: OpenPathRequest) =>
    req<{ message: string }>("POST", "/api/open", request),

  /// Persist the pane-highlight colour for the library this window is served
  /// from. ROOT path (`requestRoot`, NOT prefixed): the local-color route is
  /// mounted ONLY on the root launcher router, but a workspace/terminal/devserver
  /// window loads under a tenant prefix -- `apiPath` would prepend it and the PUT
  /// would 404 before reaching the route. The window's `?t=`
  /// bearer still travels (Authorization header), so the surface authenticates as
  /// its tenant and `require_surface_bearer` accepts it. Reaches the window's
  /// own serving origin (the desktop for local windows, that devserver for
  /// devserver windows) -- i.e. the library that minted the window. The store
  /// returns 204; surfaces without a writable color store answer 403
  /// (read-only) or 404 (no store). Callers treat this as best-effort: the
  /// menu must not break when the route is absent, so they catch + swallow.
  setLocalColor: (color: string) =>
    requestRoot<void>("PUT", "/api/library/local-color", { color }),
};

/// Wire shape for `Workspace::create_team` /
/// `Workspace::duplicate_team`. snake_case to match chan-workspace's
/// serde-default field naming. The SPA translates its own
/// camelCase `TeamDialogConfig` into this on submit.
export interface TeamMemberWire {
  handle: string;
  command: string;
  env: Record<string, string>;
  is_lead: boolean;
  position?: { row: number; col: number };
  // The submit-encoding agent is NOT carried on the wire: the server derives
  // it from `command` (+ a CHAN_AGENT env override) via SubmitAgent::derive.
  // The SPA mirror is agentForMember (teamDialog.svelte.ts), used only to
  // pick the lead identity poke's chord at bootstrap.
}

export interface TeamConfigWire {
  team_name: string;
  host_name: string;
  host_handle: string;
  /// Terminal tab-group every team terminal joins ($CHAN_TAB_GROUP),
  /// persisted in the team's config.toml. Default derived from the
  /// team-dir basename; the orchestrator resolves a -N suffix at
  /// Bootstrap.
  tab_group: string;
  auto_prefix_at: boolean;
  /// When true, the team's terminals start with the chan MCP env vars
  /// (CHAN_MCP_*) exposed. Default false (off). Mirrors
  /// `chan_workspace::TeamConfig.mcp_env`.
  mcp_env: boolean;
  created_at: string;
  members: TeamMemberWire[];
}

/// A survey pushed from the server to the SPA in an `open_survey` window
/// command. Mirrors `chan_shell::wire::SurveySpec` (camelCase) byte-for-byte;
/// the Rust half is the source of truth. The SPA
/// renders the body as markdown, numbers the options [1]..[4], and echoes
/// `surveyId` back in the reply.
export interface SurveySpec {
  surveyId: string;
  title?: string | null;
  bodyMarkdown: string;
  options: string[];
}

/// The reply body the SPA POSTs to `/api/survey/reply`.
///
/// Every survey overlay offers options PLUS an [F] follow-up AND a
/// Dismiss, so the reply has three kinds. `dismissed` carries only the
/// `surveyId` (no option index), so the asking agent can tell a dismiss apart
/// from an answer. `followup` is dismiss-shaped: a bare "host will follow up
/// later" signal telling the asking agent an answer is coming in a separate
/// prompt.
/// `windowId` (the answering window's own session id) lets the server exclude
/// this window from the `close_survey` fan-out, so the window that just replied
/// does not race a `answered_elsewhere` close against its own local clear.
export type SurveyReplyRequest =
  | {
      surveyId: string;
      kind: "option";
      optionIndex: number;
      optionLabel: string;
      windowId?: string;
    }
  | { surveyId: string; kind: "followup"; windowId?: string }
  | { surveyId: string; kind: "dismissed"; windowId?: string };

/// Body of `POST /api/window/reply` (the `cs pane` reply). camelCase to match
/// the server's `WindowReplyRequest`. `payload` is opaque to the server (the
/// CLI formats it); for a `cs pane` query it is the layout snapshot the SPA
/// built from `layout`.
export type WindowReplyRequest = {
  requestId: string;
  payload: unknown;
};

/// Body of `POST /api/open` (Contract C). snake_case to match the server's
/// `OpenRequest`. `window_id` is the submitting window (`sessionWindowId()`);
/// `target` is a workspace-relative or absolute path, or a serialized
/// `chan://graph?...` link, forwarded verbatim.
export type OpenPathRequest = {
  window_id: string;
  target: string;
};

/// Body of `POST /api/session/handover/reply` (the leader's answer to
/// `cs session handover`). camelCase to match the server. `windowId` is the
/// answering window's own id; the route checks it is the current leader holding
/// the request.
export interface SessionHandoverReplyRequest {
  requestId: string;
  windowId: string;
  accept: boolean;
  reason?: string | null;
}

/// Encode a path as a sequence of percent-encoded segments. We keep `/`
/// raw so axum's `*path` capture works.
function encPath(p: string): string {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export type { WsStatus } from "./transport";
// Dedicated per-library focus-colour watch (App.svelte subscribes
// once per window). Self-contained in transport.ts; surfaced here so the SPA
// imports it from the api module like the rest of the client surface.
export { openLocalColorWatch } from "./transport";
export { openLocalThemeWatch } from "./transport";

/// Handle for the live watcher subscription. Callable as the disposer
/// (back-compat) and also exposes the per-directory scope-subscription
/// path: `subscribeDir` / `unsubscribeDir` push `sub` / `unsub` frames
/// to the server's `ScopeRegistry`. `onReady` (passed to
/// `openWatchSocket`) fires on every (re)connect so the owner can
/// re-establish its active scopes, since the server's registry is
/// per-socket and a fresh socket starts empty.
export interface WatchSubscription {
  (): void;
  /// Subscribe this socket to a directory scope. `dir: ""` is the workspace
  /// root (idempotent server-side). Best-effort while the socket is
  /// connecting; the owner re-subscribes from `onReady`.
  subscribeDir(dir: WatchScopeDir): void;
  /// Unsubscribe this socket from a directory scope. Last unsubscribe
  /// across all sockets tears the server-side watcher down.
  unsubscribeDir(dir: WatchScopeDir): void;
  /// Report this window's in-flight transfer count to the server (the
  /// per-window active-transfer signal the desktop close guard queries).
  /// Best-effort while connecting; the owner re-announces from `onReady`.
  reportTransfers(active: number): void;
  /// Close the socket and stop reconnecting.
  close(): void;
}

/// Open the watcher subscription. Auto-reconnects with capped
/// exponential backoff; the status callback workspaces the disconnect
/// overlay. `onReady` fires on each (re)connect so the caller can
/// re-establish per-directory scope subscriptions (the server registry
/// is per-socket). Returns a `WatchSubscription`: callable as the
/// disposer, plus typed `subscribeDir` / `unsubscribeDir` helpers.
export function openWatchSocket(
  onEvent: (e: unknown) => void,
  onStatus?: (s: import("./transport").WsStatus, attempt: number) => void,
  onReady?: () => void,
): WatchSubscription {
  // Tag the socket with this window's session id so the server's
  // window-presence map (GET /api/windows, `cs window list`) sees the
  // window as connected for the socket's lifetime.
  const socket: WatchSocket = openWatch(onEvent, onStatus, onReady, sessionWindowId());
  const sub = (() => socket.close()) as WatchSubscription;
  sub.subscribeDir = (dir: WatchScopeDir) => socket.send({ type: "sub", dir });
  sub.unsubscribeDir = (dir: WatchScopeDir) => socket.send({ type: "unsub", dir });
  sub.reportTransfers = (active: number) => socket.send({ type: "transfers", active });
  sub.close = () => socket.close();
  return sub;
}
