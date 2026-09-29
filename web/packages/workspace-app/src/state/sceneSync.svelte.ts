/// Live Excalidraw scene sessions: the client half of chan-server's
/// per-scene authority (`/api/scene/ws`). While a canvas tab is ATTACHED,
/// the server owns the scene and disk; local changes ride element-level
/// pushes (the authority merges by Excalidraw's version/versionNonce rule
/// and fans accepted values to the other attachments), remote changes
/// arrive as `update` frames the canvas reconciles, and saves become
/// flush confirmations instead of PUTs. When the channel is unavailable
/// the tab degrades to the classic autosave + CAS path with a valid mtime
/// token from the last `flush` frame.
///
/// One SceneSession per TAB (not per path), mirroring docSync: the
/// session outlives canvas remounts (cross-pane move) via a short release
/// linger. Unlike docSync there is no CodeMirror shadow/rebase machinery:
/// the canvas IS the local state, remote content applies through
/// `reconcileElements`, and a shadow of the scene (its elements, appState
/// and files) only serves snapshot replay for a canvas that binds after the
/// frames landed.
///
/// The canvas half plugs in through [`SceneCanvasBinding`]
/// (ExcalidrawCanvas.svelte implements it): the session drives the
/// binding from socket callbacks and the binding hands local deltas to
/// [`SceneSession.pushScene`]. Saved-state semantics are ack-based:
/// `tab.saved` advances to `tab.content` whenever a `push-ok` lands with
/// nothing left unpushed, and whenever the canvas mirrors its board into
/// the buffer while attached with nothing of its own unconfirmed, as after a
/// peer's edit,
/// so dirty keeps meaning "unconfirmed local changes" for every existing
/// consumer.
///
/// Import cycle note: tabs.svelte.ts consumes this module only through the
/// live-session kind registered at the bottom, whose members are shared
/// array slots with docSync, so the import edge points one way (sceneSync
/// -> tabs) and the classic save path works even if this module never
/// loads.

import {
  createSocket,
  withTokenQuery,
  WS_RECONNECT_BACKOFF_MIN_MS,
  WS_RECONNECT_BACKOFF_MAX_MS,
} from "../api/transport";
import { sessionWindowId } from "../api/client";
import { isDraftPath } from "./workspace.svelte";
import { isExcalidraw } from "./fileTypes";
import { windowCaps } from "./windowCaps";
import {
  liveFileTabById,
  markTabFileMissing,
  registerLiveSessionKind,
  registerPaneModeSettledSink,
  setTabDocState,
  type DocSyncStatus,
  type FileTab,
} from "./tabs.svelte";

/// Feature flag. Default ON; localStorage `chan.scenesync = "0"` opts a
/// browser out, and the capability probe below silently turns everything
/// off against a pre-scene-sync server.
const SCENESYNC_FLAG_KEY = "chan.scenesync";
const SCENESYNC_DEFAULT_ON = true;

/// Keep the socket + shadow alive briefly after the owning canvas
/// releases; a cross-pane tab move is a full component remount and the
/// linger carries the session across the swap.
export const SCENE_RELEASE_LINGER_MS = 250;

/// Reconnect grace, mirroring docSync: a socket drop shows as
/// `reconnecting` (classic autosave stays suppressed) for at most this
/// many attempts / this long, then the session degrades and classic
/// autosave resumes. Background retries continue at capped backoff.
export const SCENE_RECONNECT_GRACE_ATTEMPTS = 2;
export const SCENE_RECONNECT_GRACE_MS = 3000;

/// A dial that produces no frame within this window counts as a failed
/// attempt.
export const SCENE_ATTACH_TIMEOUT_MS = 5000;

/// Ceiling on a save-funnel flush await; covers the authority's ~800ms
/// flush debounce plus the write with margin.
export const SCENE_FLUSH_TIMEOUT_MS = 4000;

/// Bound on the degraded-fallback wait for an in-flight push to settle
/// before the classic PUT fires. Keeps the two writers serialized: the
/// push already on the wire lands (and its push-ok restamps the CAS
/// token) before the PUT reads that token.
export const SCENE_FALLBACK_SETTLE_MS = 2000;

/// Outbound pointer cadence: trailing-edge throttle on pointer moves,
/// applied inside the session so every binding inherits it.
export const SCENE_CURSOR_THROTTLE_MS = 100;

/// Client-side mirror of the server's text write limit (TEXT_WRITE_LIMIT,
/// 2 MiB), compared against the serialized buffer length as a cheap
/// gate; growth past the true limit mid-session is rejected loudly by
/// the authority and the session degrades.
const SCENE_MAX_LEN = 2 * 1024 * 1024;

/// Capability probe: the FIRST scene-ws connect that closes before any
/// frame latches "unsupported" module-wide. `null` = unknown.
let serverSupportsSceneSync: boolean | null = null;

export function sceneSyncEnabled(): boolean {
  // Live sessions are a workspace-tenant capability. The gate must fire
  // BEFORE any dial: on a standalone window the first failed connect would
  // latch the module off, a silently-correct state that masks a real
  // gating bug, so the window mode short-circuits it instead.
  if (!windowCaps.workspace) return false;
  if (serverSupportsSceneSync === false) return false;
  if (typeof localStorage === "undefined") return false;
  try {
    const v = localStorage.getItem(SCENESYNC_FLAG_KEY);
    if (v === "0" || v === "off" || v === "false") return false;
    if (v === "1" || v === "on" || v === "true") return true;
  } catch {
    return false;
  }
  return SCENESYNC_DEFAULT_ON;
}

/// Whether `tab` qualifies for a live scene session. Reads exactly the
/// fields the acquire/release $effect should track: path, mode, loading,
/// fileMissing and the hold on a refused text. Deliberately NOT content
/// (size is checked untracked at acquire time), NOT the refusal's reason
/// (a new reason is the same hold) and NOT readMode/fsWritable (read-only
/// tabs still attach, they just never send).
export function isSceneSyncEligible(tab: FileTab): boolean {
  if (!sceneSyncEnabled()) return false;
  if (tab.loading || tab.fileMissing) return false;
  // A refused text stays with the classic save until a write of it lands.
  if (tab.refusedUnwritten) return false;
  if (tab.mode !== "canvas") return false;
  if (!isExcalidraw(tab.path)) return false;
  // Draft close/promote interleaves saves with file moves; excluded v1.
  if (isDraftPath(tab.path)) return false;
  return true;
}

export function sceneWsPath(path: string, windowId: string): string {
  const params = new URLSearchParams({ path, w: windowId });
  return `/api/scene/ws?${params.toString()}`;
}

function sceneWsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const p = withTokenQuery(sceneWsPath(path, sessionWindowId()));
  return `${proto}//${window.location.host}${p}`;
}

// ---- wire frames (pinned contract; serde tag = "type") --------------------
// Shapes match the serde pins in crates/chan-server/src/routes/scene.rs.

export type WireElement = Record<string, unknown>;
export type WireAppState = Record<string, unknown>;
export type WireFiles = Record<string, unknown>;

type ServerFrame =
  | {
      type: "snapshot";
      path: string;
      version: number;
      elements: WireElement[];
      appState: WireAppState;
      files: WireFiles;
      dirty: boolean;
      mtime_ns: string | null;
      cursors: ScenePeerCursorFrame[];
    }
  | {
      type: "update";
      version: number;
      elements: WireElement[];
      appState?: WireAppState;
      files?: WireFiles;
    }
  | { type: "push-ok"; version: number }
  | ({ type: "cursor" } & ScenePeerCursorFrame)
  | { type: "cursor-gone"; id: number }
  | { type: "flush"; dirty: boolean; mtime_ns?: string | null; error?: string }
  | { type: "removed" }
  | { type: "error"; message: string; reason?: string }
  | { type: "closed"; reason?: string };

export type ScenePeerCursorFrame = {
  /// Server attach id: unique per socket, NOT per window.
  id: number;
  /// window_id, the roster key that resolves a display name.
  w: string;
  x: number;
  y: number;
  tool?: string;
  selected?: string[];
};

export type ScenePeerCursor = {
  w: string;
  x: number;
  y: number;
  tool?: string;
  selected?: string[];
};

/// Error reasons that must not trigger a reconnect loop (the retry would
/// fail identically). Transient reasons (bad-scene, malformed-frame,
/// session-closed) recover through reconnect + snapshot instead.
const PERMANENT_ERROR_REASONS = new Set(["attach-failed", "doc-too-large"]);

/// The canvas half of a session (ExcalidrawCanvas.svelte implements it).
/// The session calls it from its socket's frames and closes, from the replay
/// `bindCanvas` makes when the canvas binds, from the save funnel
/// (`flushPendingLocal`, through `flush` and the waiters' check), from the
/// waiters' check, the force-reload prompt's query and the saved mark's check
/// (`hasPendingLocal`, the last reached from the canvas's own flush through
/// `bufferMirrored`), and from the roster hook (`collaboratorsChanged`).
export type SceneCanvasBinding = {
  /// Full authority state: reconcile every element (tombstones
  /// included) into the canvas, adopt appState, register files. The
  /// appState is left out of a later snapshot on the same socket while this
  /// window's appState claim stands.
  applySnapshot(elements: WireElement[], appState: WireAppState | undefined, files: WireFiles): void;
  /// Accepted values fanned from the authority.
  applyUpdate(f: {
    elements: WireElement[];
    appState?: WireAppState;
    files?: WireFiles;
  }): void;
  /// Peer pointers changed; read `peerCursorSnapshot()` and repaint the
  /// collaborators layer.
  collaboratorsChanged(): void;
  /// Locally-changed elements not yet handed to `pushScene`?
  hasPendingLocal(): boolean;
  /// Hand pending local deltas to `pushScene` now (the maybePush
  /// analogue; called after snapshots and when the save funnel needs
  /// quiescence).
  flushPendingLocal(): void;
  /// Forget that this payload was handed over. `pushScene` answers true for
  /// a coalesced push and for one on the wire, and neither has been
  /// acknowledged yet: a drop, or the next socket's first snapshot, throws
  /// both away. It takes the same three parts `pushScene` does, because the
  /// canvas marks all three on a true and a mark left in place keeps its part
  /// out of every later push: an element stays on the canvas having reached
  /// nobody, and a file leaves the authority holding an element that
  /// references bytes it does not have. The appState is handed back too, but
  /// the snapshot the session hands the canvas next replaces it, so a
  /// released appState is not offered again.
  forgetBroadcast(elements: WireElement[], appState?: WireAppState, files?: WireFiles): void;
};

// ---- session ---------------------------------------------------------------

const registry = new Map<string, SceneSession>();

/// Coalesced outbound state while a push is in flight: later local
/// deltas for the same element replace earlier ones (the canvas already
/// carries the newest version), appState replaces wholesale, files
/// accumulate.
type QueuedPush = {
  elements: Map<string, WireElement>;
  appState: WireAppState | null;
  files: WireFiles | null;
};

/// What a push claimed, in the shape `pushScene` was handed it, so the wire
/// payload and the coalesced one are one type and the hand-back cannot cover
/// one part of a claim and miss another.
function claimedPush(
  elements: WireElement[],
  appState: WireAppState | undefined,
  files: WireFiles | undefined,
): QueuedPush {
  const byId = new Map<string, WireElement>();
  for (const el of elements) {
    const id = el.id;
    if (typeof id === "string") byId.set(id, el);
  }
  return { elements: byId, appState: appState ?? null, files: files ?? null };
}

/// The authority's merge rule for one element (`stored_wins` in the server's
/// scene sessions, the library's reconcile without its guards for an element
/// being edited): the element it stores stays against an incoming one of a
/// lower version, and of the same version when its nonce is the lower. A
/// missing version or nonce reads as 0, as the authority reads it.
function storedElementWins(stored: WireElement, incoming: WireElement): boolean {
  const version = (el: WireElement) => (typeof el.version === "number" ? el.version : 0);
  const nonce = (el: WireElement) => (typeof el.versionNonce === "number" ? el.versionNonce : 0);
  if (version(stored) !== version(incoming)) return version(stored) > version(incoming);
  return nonce(stored) < nonce(incoming);
}

export class SceneSession {
  readonly tabId: string;
  readonly path: string;
  /// The tab handed to the constructor. Read only through `tab`, which
  /// prefers the layout's current object; this is the fallback for the
  /// window between the tab leaving the layout and this session being
  /// released.
  private readonly boundTab: FileTab;

  /// The tab this session mirrors status onto and reads the scene from.
  /// A move replaces the tab object in the layout, so a session that
  /// kept its constructor argument would write to an object nothing
  /// renders or saves from, and the frozen mirror would tell the classic
  /// save path to stand down for a session that has stopped owning saves.
  private get tab(): FileTab {
    return liveFileTabById(this.tabId) ?? this.boundTab;
  }

  private status: DocSyncStatus = "connecting";
  private ws: WebSocket | null = null;
  private sawFrameOnSocket = false;
  private closedByUs = false;
  private retryStopped = false;
  private backoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
  private reconnectAttempts = 0;
  private droppedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  private binding: SceneCanvasBinding | null = null;

  /// The scene replayed into a canvas that binds after the frames landed:
  /// snapshot and update frames, plus this window's own pushes, each with
  /// all three of its parts, taken when `pushScene` takes the push. A replay
  /// is an adopt, so a part this left out would be adopted over the push:
  /// the older value would go on the board and never be offered again. A
  /// discarded push leaves its parts here until the next snapshot replaces
  /// them, and no replay comes before that snapshot.
  private shadowElements = new Map<string, WireElement>();
  private shadowAppState: WireAppState = {};
  private shadowFiles: WireFiles = {};
  /// The socket the last snapshot came on. Every dial answers with a
  /// snapshot taken when that socket attached, so until the current socket's
  /// own has landed, a push would be applied after it and handed back by it
  /// as never accepted, and a replay could hand the canvas a push a drop
  /// discarded. Both wait for it.
  private snapshotSocket: WebSocket | null = null;
  private get haveSnapshot(): boolean {
    return this.ws !== null && this.snapshotSocket === this.ws;
  }
  /// Authority-side dirty flag, tracked from snapshot/update/flush
  /// frames so `flush()` can resolve immediately when there is nothing
  /// unflushed.
  private serverDirty = false;
  /// The save error this session wrote for a flush the server could not
  /// make. A flush that lands clears it, and only it: an error the classic
  /// save wrote stays until a save of that path clears it.
  private flushError: string | null = null;

  private pushInFlight = false;
  /// Fallback-settle waiters: resolved the moment no push is in flight
  /// (or on their own bound). See awaitPushSettled.
  private pushSettleWaiters: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  /// The push currently on the wire, in the same three parts the queued one
  /// has, so a drop, or the next socket's first snapshot, can hand all of it
  /// back to the canvas: whether the authority read it is not known. Cleared
  /// by the ack.
  private unacked: QueuedPush | null = null;
  private queued: QueuedPush | null = null;

  private cursors = new Map<number, ScenePeerCursor>();
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: { x: number; y: number; tool?: string; selected?: string[] } | null =
    null;

  private flushWaiters: {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(tab: FileTab) {
    this.tabId = tab.id;
    this.path = tab.path;
    this.boundTab = tab;
    this.mirror();
    this.dial();
  }

  // ---- public surface ------------------------------------------------------

  /// True while this session owns saves: the classic autosave/PUT path
  /// must stay quiet in these states (see `isDocAttached` in
  /// tabs.svelte.ts, which reads the mirrored `tab.doc`).
  ownsSaves(): boolean {
    return (
      this.status === "attached" ||
      this.status === "connecting" ||
      this.status === "reconnecting"
    );
  }

  /// True when the session is degraded specifically by a CONNECTION-class
  /// outage that is still retrying; the save path suppresses the doomed
  /// classic PUT (same rationale and shape as DocSession.isOutagePaused).
  isOutagePaused(): boolean {
    if (this.retryStopped || this.closedByUs) return false;
    if (this.status !== "degraded") return false;
    return !(this.ws !== null && this.ws.readyState === WebSocket.OPEN);
  }

  /// True while the authority holds scene state the DISK does not: deltas
  /// the canvas has not handed over, a push on the wire, a coalesced push
  /// waiting behind it, or an authority that has taken changes it has not
  /// flushed. The force-reload prompt keys on this, because for an
  /// attached canvas `content === saved` only means the authority took
  /// the elements, never that they reached the file.
  ///
  /// It over-reports for a degraded session: the deltas the canvas still
  /// holds are the bytes the classic PUT already wrote, so the prompt warns
  /// about a tab that is fully on disk. That is the safe direction for a
  /// prompt that guards a discard, and the alternative reads the save path
  /// from here to learn which of the two wrote last.
  hasUnflushedState(): boolean {
    if (this.serverDirty || this.pushInFlight || this.queued !== null) return true;
    return this.binding?.hasPendingLocal() ?? false;
  }

  /// A classic PUT for this tab just landed on disk while the session was
  /// degraded with its channel still up. The authority's scene is now
  /// behind the file, so promoting on the snapshot it already has would
  /// re-adopt stale elements: redial instead, and the fresh snapshot both
  /// heals the status and replays whatever is still only local. Sessions
  /// degraded by a socket-down outage keep their own retry loop, and a
  /// permanently stopped one stays stopped.
  healAfterFallbackSave(): void {
    if (this.retryStopped || this.closedByUs) return;
    if (this.status !== "degraded") return;
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.setStatus("reconnecting");
    this.dial();
  }

  peers(): number {
    const self = sessionWindowId();
    const windows = new Set<string>();
    for (const c of this.cursors.values()) {
      if (c.w !== self) windows.add(c.w);
    }
    return windows.size;
  }

  /// Snapshot of the peer cursor cache (for the collaborators layer).
  peerCursorSnapshot(): ReadonlyMap<number, ScenePeerCursor> {
    return this.cursors;
  }

  /// Attach the canvas half. Replays the current authority shadow so a
  /// canvas that mounted after the snapshot landed still converges, then
  /// asks for pending local deltas (offline edits push as soon as the
  /// channel is up). Before the current socket's snapshot there is nothing
  /// to replay: that snapshot reaches the canvas when it lands.
  bindCanvas(binding: SceneCanvasBinding): void {
    if (this.releaseTimer !== null) this.retain();
    this.binding = binding;
    if (this.haveSnapshot) {
      binding.applySnapshot(
        [...this.shadowElements.values()],
        this.shadowAppState,
        this.shadowFiles,
      );
      binding.collaboratorsChanged();
      binding.flushPendingLocal();
    }
  }

  unbindCanvas(binding: SceneCanvasBinding): void {
    if (this.binding !== binding) return;
    this.binding = null;
    this.clearCursorTimer();
    this.pendingCursor = null;
  }

  /// Outbound push entry for the binding. Coalesces while a push is in
  /// flight; the ack pump drains the queue.
  ///
  /// Returns whether the authority has these deltas or will: false means
  /// nothing was taken and the caller still owns the change, so a canvas
  /// that marks its elements as broadcast must do so only on true. A
  /// coalesced push IS taken, which is why the in-flight branch answers
  /// true. After the next snapshot the binding pushes the elements and files
  /// that stayed local; an appState that stayed local is replaced by that
  /// snapshot's.
  pushScene(elements: WireElement[], appState?: WireAppState, files?: WireFiles): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.haveSnapshot) {
      return false;
    }
    // Single-writer discipline: a degraded tab's saves belong to the
    // classic PUT path, so this must not keep pushing on a still-open
    // socket. The same edit travelling both channels is the duplicated
    // element and stale-token recipe. Healing back to `attached` re-opens
    // it, and the snapshot that heals also replays what stayed local.
    if (this.status === "degraded" || this.status === "off") return false;
    if (this.isReadOnlyAttach()) return false;
    for (const el of elements) this.foldIntoShadow(el);
    if (appState !== undefined) this.shadowAppState = appState;
    if (files !== undefined) this.shadowFiles = { ...this.shadowFiles, ...files };
    if (this.pushInFlight) {
      const q = this.queued ?? {
        elements: new Map<string, WireElement>(),
        appState: null,
        files: null,
      };
      for (const el of elements) {
        const id = el.id;
        if (typeof id === "string") q.elements.set(id, el);
      }
      if (appState !== undefined) q.appState = appState;
      if (files !== undefined) q.files = { ...(q.files ?? {}), ...files };
      this.queued = q;
      return true;
    }
    this.pushInFlight = true;
    this.unacked = claimedPush(elements, appState, files);
    this.send({
      type: "push",
      elements,
      ...(appState !== undefined ? { appState } : {}),
      ...(files !== undefined ? { files } : {}),
    });
    return true;
  }

  /// The canvas has mirrored its board into the tab's buffer, with none of
  /// its appState left unpushed. A mirror that follows a peer's edit or an
  /// ack carries nothing of this window's that the authority has not
  /// acknowledged, and no push-ok comes for it; one that carries a local change finds that change pending or on
  /// the wire and leaves the mark to its push-ok. Only an attached session
  /// owns the mark: a degraded one's buffer is the classic save's, and a
  /// connecting or reconnecting one has no snapshot of this socket yet.
  bufferMirrored(): void {
    if (this.status !== "attached") return;
    this.confirmSaved();
  }

  /// Outbound presence: trailing-edge throttle on pointer moves.
  sendCursor(x: number, y: number, tool?: string, selected?: string[]): void {
    if (this.isReadOnlyAttach()) return;
    this.pendingCursor = { x, y, tool, selected };
    if (this.cursorTimer !== null) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      const c = this.pendingCursor;
      this.pendingCursor = null;
      if (!c) return;
      this.send({
        type: "cursor",
        x: c.x,
        y: c.y,
        ...(c.tool !== undefined ? { tool: c.tool } : {}),
        ...(c.selected !== undefined ? { selected: c.selected } : {}),
      });
    }, SCENE_CURSOR_THROTTLE_MS);
  }

  /// Save-funnel entry: ensure every local change is confirmed by the
  /// authority and the authority has flushed to disk. Resolves false on
  /// timeout or flush error; the caller degrades the session and falls
  /// back to the classic PUT.
  flush(timeoutMs: number = SCENE_FLUSH_TIMEOUT_MS): Promise<boolean> {
    if (!this.ownsSaves()) return Promise.resolve(false);
    this.binding?.flushPendingLocal();
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.flushWaiters = this.flushWaiters.filter((w) => w !== waiter);
          resolve(false);
        }, timeoutMs),
      };
      this.flushWaiters.push(waiter);
      this.checkFlushWaiters();
    });
  }

  /// Drop to the classic autosave + CAS path. The last `flush` frame's
  /// mtime token is already stamped on the tab. Background reconnects
  /// continue; success returns the session to `attached`.
  degrade(): void {
    if (this.status === "degraded" || this.status === "off") return;
    this.setStatus("degraded");
  }

  /// Fallback settle: resolves once no push is in flight, bounded by
  /// `timeoutMs`. The degrade gate in pushScene stops NEW pushes; this
  /// waits out the one already on the wire so the classic fallback PUT
  /// never interleaves with it, and so the push's own push-ok gets its
  /// chance to restamp the tab's CAS token before the PUT reads it.
  awaitPushSettled(timeoutMs: number = SCENE_FALLBACK_SETTLE_MS): Promise<void> {
    if (!this.pushInFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.pushSettleWaiters = this.pushSettleWaiters.filter(
            (w) => w !== waiter,
          );
          resolve();
        }, timeoutMs),
      };
      this.pushSettleWaiters.push(waiter);
    });
  }

  /// The in-flight push settled (answered, superseded, or its socket
  /// died): release any fallback-settle waiters with it.
  private clearPushInFlight(): void {
    this.pushInFlight = false;
    for (const w of this.pushSettleWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  /// Re-apply the mirror onto whatever tab the layout holds now.
  ///
  /// A Hybrid Nav commit replaces every tab object with a clone taken when
  /// the draft was entered, so a status mirrored while the draft was up
  /// sits on an object the commit discarded and the tab that replaced it
  /// reads the status this session had at entry. Nothing else corrects it:
  /// `mirror` runs on a status change, a cursor frame or a snapshot, and a
  /// re-acquire only retains. A tab frozen at `attached` over a session
  /// that has stopped owning saves swallows the classic PUT, so this is a
  /// save loss and not a stale label.
  resyncMirror(): void {
    this.mirror();
  }

  /// Tear the session down. `linger` keeps the socket + shadow alive for
  /// SCENE_RELEASE_LINGER_MS so a canvas remount (cross-pane move) can
  /// re-acquire; an immediate release (tab close, rename rekey, file
  /// discard) detaches now, which also tells the server to flush
  /// promptly.
  release(opts?: { immediate?: boolean }): void {
    if (opts?.immediate) {
      this.destroy();
      return;
    }
    if (this.releaseTimer !== null) return;
    this.releaseTimer = setTimeout(() => this.destroy(), SCENE_RELEASE_LINGER_MS);
  }

  /// Cancel a pending lingered release (the tab re-acquired).
  retain(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  // ---- outbound plumbing ---------------------------------------------------

  private isReadOnlyAttach(): boolean {
    return this.tab.readMode || !this.tab.fsWritable;
  }

  /// Tell the canvas that everything `pushScene` claimed and the authority
  /// has not acknowledged is local again: the payload on the wire, which the
  /// authority may or may not have read, and the one coalesced behind it, in
  /// all three of their parts. Called wherever those are discarded: at the
  /// socket's close and at the next socket's first snapshot.
  private releaseUnaccepted(): void {
    const wire = this.unacked;
    const queued = this.queued;
    this.unacked = null;
    const elements = [
      ...(wire?.elements.values() ?? []),
      ...(queued?.elements.values() ?? []),
    ];
    const files =
      wire?.files !== null && wire?.files !== undefined
        ? { ...wire.files, ...(queued?.files ?? {}) }
        : (queued?.files ?? undefined);
    // Either claim clears the canvas's baseline, so the newer one is what
    // goes back.
    const appState = queued?.appState ?? wire?.appState ?? undefined;
    if (elements.length === 0 && files === undefined && appState === undefined) return;
    this.binding?.forgetBroadcast(elements, appState, files);
  }

  private foldIntoShadow(el: WireElement): void {
    const id = el.id;
    if (typeof id === "string") this.shadowElements.set(id, el);
  }

  private drainQueued(): void {
    const q = this.queued;
    if (!q) return;
    this.queued = null;
    if (q.elements.size === 0 && q.appState === null && q.files === null) return;
    this.pushInFlight = true;
    this.unacked = q;
    this.send({
      type: "push",
      elements: [...q.elements.values()],
      ...(q.appState !== null ? { appState: q.appState } : {}),
      ...(q.files !== null ? { files: q.files } : {}),
    });
  }

  private send(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // The close handler owns recovery.
    }
  }

  // ---- socket lifecycle ------------------------------------------------

  private dial(): void {
    this.clearReconnectTimer();
    this.closeSocket();
    this.sawFrameOnSocket = false;
    let ws: WebSocket;
    try {
      ws = createSocket(sceneWsUrl(this.path));
    } catch {
      this.onSocketClosed();
      return;
    }
    this.ws = ws;
    this.attachTimer = setTimeout(() => {
      // No frame within the window: count the dial as failed.
      if (!this.sawFrameOnSocket) this.closeSocket(), this.onSocketClosed();
    }, SCENE_ATTACH_TIMEOUT_MS);
    // Every dial answers with a full snapshot (no incremental catch-up
    // in the scene contract), so `attached` always waits for it; there
    // is no on-open promotion like docSync's resumed-socket path.
    ws.onopen = () => {};
    ws.onmessage = (m) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(m.data as string) as ServerFrame;
      } catch {
        return;
      }
      if (!this.sawFrameOnSocket) {
        this.sawFrameOnSocket = true;
        serverSupportsSceneSync = true;
        this.clearAttachTimer();
        this.onChannelUp();
      }
      this.onFrame(frame);
    };
    ws.onclose = () => this.onSocketClosed();
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private onChannelUp(): void {
    this.backoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
    this.reconnectAttempts = 0;
    this.droppedAt = 0;
  }

  private onSocketClosed(): void {
    this.clearAttachTimer();
    this.ws = null;
    this.releaseUnaccepted();
    this.clearPushInFlight();
    this.queued = null;
    if (this.closedByUs || this.retryStopped) return;
    // Capability probe: the first scene-ws connect that closes before
    // any frame means an old server; latch module-wide and go quiet.
    if (serverSupportsSceneSync === null && !this.sawFrameOnSocket) {
      serverSupportsSceneSync = false;
    }
    if (serverSupportsSceneSync === false) {
      this.setStatus("off");
      this.retryStopped = true;
      return;
    }
    if (this.droppedAt === 0) this.droppedAt = Date.now();
    this.reconnectAttempts += 1;
    const inGrace =
      this.reconnectAttempts <= SCENE_RECONNECT_GRACE_ATTEMPTS &&
      Date.now() - this.droppedAt < SCENE_RECONNECT_GRACE_MS;
    if (this.status === "attached" || this.status === "reconnecting") {
      this.setStatus(inGrace ? "reconnecting" : "degraded");
    } else if (this.status === "connecting" && !inGrace) {
      this.setStatus("degraded");
    }
    this.checkFlushWaiters();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, WS_RECONNECT_BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.dial(), delay);
  }

  private closeSocket(): void {
    const w = this.ws;
    this.ws = null;
    if (!w) return;
    // Defuse before close so a queued onclose can't fire after a newer
    // socket already took over.
    w.onopen = null;
    w.onclose = null;
    w.onerror = null;
    w.onmessage = null;
    try {
      w.close();
    } catch {
      // Already closed; that is what we wanted.
    }
  }

  // ---- frames ------------------------------------------------------------

  private onFrame(f: ServerFrame): void {
    switch (f.type) {
      case "snapshot":
        this.onSnapshot(f);
        return;
      case "update":
        this.onUpdate(f);
        return;
      case "push-ok":
        this.tab.authorityVersion = f.version;
        this.pushInFlight = false;
        this.unacked = null;
        this.drainQueued();
        // A push the ack drains from the queue is on the wire in its
        // turn, and a fallback save waits for it too.
        if (!this.pushInFlight) this.clearPushInFlight();
        this.confirmSaved();
        this.checkFlushWaiters();
        return;
      case "cursor":
        this.cursors.set(f.id, {
          w: f.w,
          x: f.x,
          y: f.y,
          tool: f.tool,
          selected: f.selected,
        });
        this.binding?.collaboratorsChanged();
        this.mirror();
        return;
      case "cursor-gone":
        this.cursors.delete(f.id);
        this.binding?.collaboratorsChanged();
        this.mirror();
        return;
      case "flush":
        this.onFlush(f);
        return;
      case "removed":
        // The backing file vanished on disk. Route into the missing-file
        // machinery; the acquire/release effect releases this session on
        // the fileMissing flip and the classic recovery UX takes over.
        this.tab.savedMtimeNs = null;
        this.tab.savedMtime = null;
        this.tab.authorityVersion = null;
        markTabFileMissing(this.tabId);
        return;
      case "error":
        console.warn("[chan] scene session error", this.path, f.reason, f.message);
        if (f.reason !== undefined && PERMANENT_ERROR_REASONS.has(f.reason)) {
          this.retryStopped = true;
          this.degrade();
        }
        // The server closes the socket after an error frame; transient
        // reasons recover through the reconnect + snapshot path.
        return;
      case "closed":
        // Registry-initiated teardown (storage reset, shutdown): stop
        // for good, classic behaviors resume.
        this.retryStopped = true;
        this.setStatus("off");
        this.closeSocket();
        return;
    }
  }

  private onSnapshot(f: Extract<ServerFrame, { type: "snapshot" }>): void {
    // The server fans a later snapshot on a socket that had its own when a
    // conflict's resolution leaves the scene unchanged or overwrites the
    // disk. A push this window sent on that socket and the server has not
    // acked is read after it, applied after it and acked on the same socket,
    // so a later snapshot ends none of them: they stay claimed, their parts
    // stay in the scene over the snapshot's but for an element the authority
    // keeps against them, and while this window's appState claim stands the
    // snapshot's appState stays off the board, as an update's does.
    const later = this.ws !== null && this.snapshotSocket === this.ws;
    this.shadowElements = new Map();
    for (const el of f.elements) this.foldIntoShadow(el);
    this.shadowAppState = f.appState;
    this.shadowFiles = f.files;
    this.snapshotSocket = this.ws;
    this.tab.authorityVersion = f.version;
    let claim: WireAppState | null = null;
    if (later) {
      for (const push of [this.unacked, this.queued]) {
        if (push === null) continue;
        // The authority applies the push after this snapshot, so the scene
        // keeps the snapshot's element wherever the authority keeps it.
        for (const el of push.elements.values()) {
          const stored = this.shadowElements.get(el.id as string);
          if (stored === undefined || !storedElementWins(stored, el)) this.foldIntoShadow(el);
        }
        if (push.files !== null) this.shadowFiles = { ...this.shadowFiles, ...push.files };
      }
      claim = this.queued?.appState ?? this.unacked?.appState ?? null;
      if (claim !== null) this.shadowAppState = claim;
    } else {
      // A socket's first snapshot opens a fresh sync epoch: a push still
      // claimed was sent on an earlier socket and is never acked on this
      // one. Hand its parts back before dropping them; `applySnapshot` below
      // marks the elements and files the authority holds, so only those it
      // lacks are offered again.
      this.releaseUnaccepted();
      this.clearPushInFlight();
      this.queued = null;
    }
    this.serverDirty = f.dirty;
    this.stampMtime(f.mtime_ns ?? null);
    this.cursors.clear();
    for (const c of f.cursors) {
      this.cursors.set(c.id, { w: c.w, x: c.x, y: c.y, tool: c.tool, selected: c.selected });
    }
    this.mirror();
    if (this.binding) {
      this.binding.applySnapshot(f.elements, claim !== null ? undefined : f.appState, f.files);
      this.binding.collaboratorsChanged();
    }
    this.promoteIfChannelUp();
    // Locally-newer elements survive the canvas reconciliation and must
    // reach the authority (offline-edit and reattach cases). This runs
    // AFTER the promotion because `pushScene` refuses to send while the
    // session is degraded, and a snapshot landing on a degraded session is
    // exactly the reattach this rescue exists for.
    this.binding?.flushPendingLocal();
    this.checkFlushWaiters();
  }

  private onUpdate(f: Extract<ServerFrame, { type: "update" }>): void {
    this.tab.authorityVersion = f.version;
    // The authority applies a push after every update it fanned before the
    // push arrived, so while this window's appState claim is on the wire or
    // queued behind one, the claim replaces this update's appState there:
    // the board keeps its own and the shadow keeps the claim.
    const claimed = (this.unacked?.appState ?? this.queued?.appState ?? null) !== null;
    for (const el of f.elements) this.foldIntoShadow(el);
    if (f.appState !== undefined && !claimed) this.shadowAppState = f.appState;
    if (f.files !== undefined) this.shadowFiles = { ...this.shadowFiles, ...f.files };
    this.serverDirty = true;
    this.binding?.applyUpdate({
      elements: f.elements,
      appState: claimed ? undefined : f.appState,
      files: f.files,
    });
    this.checkFlushWaiters();
  }

  private onFlush(f: Extract<ServerFrame, { type: "flush" }>): void {
    if (f.error !== undefined) {
      // Repeated flush failure server-side; the session stays alive
      // (content safe in memory and on every client), so the board stays
      // and the save line says the file lacks it. Any pending save falls
      // back through the degrade path.
      this.flushError = `the server could not write it (${f.error})`;
      this.tab.saveError = this.flushError;
      for (const w of this.flushWaiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(false);
      }
      return;
    }
    if (this.flushError !== null && this.tab.saveError === this.flushError) {
      this.tab.saveError = null;
    }
    this.flushError = null;
    this.serverDirty = f.dirty;
    if (f.mtime_ns !== undefined) this.stampMtime(f.mtime_ns);
    this.checkFlushWaiters();
  }

  // ---- state mirroring -------------------------------------------------

  /// Promote to `attached` whenever the snapshot is absorbed and the
  /// channel is genuinely up. Deliberately not keyed on the CURRENT
  /// status so a degraded session whose background retry lands a
  /// snapshot heals.
  private promoteIfChannelUp(): void {
    if (this.retryStopped) return;
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.haveSnapshot) return;
    this.setStatus("attached");
  }

  /// Stamp the authority's flush mtime as the tab's CAS token; this is
  /// what makes a later degradation CAS-correct.
  private stampMtime(mtimeNs: string | null): void {
    this.tab.savedMtimeNs = mtimeNs;
    if (mtimeNs === null) {
      this.tab.savedMtime = null;
      return;
    }
    const n = Number(mtimeNs);
    this.tab.savedMtime = Number.isFinite(n) ? n / 1e9 : null;
  }

  private setStatus(s: DocSyncStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.mirror();
    this.checkFlushWaiters();
  }

  private mirror(): void {
    setTabDocState(this.tab, { state: this.status, peers: this.peers() });
  }

  /// Ack-based saved semantics: with nothing local on the wire, queued or
  /// not yet handed over, the buffer holds no change of this window's that
  /// the authority has not acknowledged. It can still lag the authority, by
  /// a peer's edit the canvas's flush has not mirrored yet.
  private confirmSaved(): void {
    if (this.pushInFlight || this.queued !== null) return;
    if (this.binding?.hasPendingLocal() ?? false) return;
    this.tab.saved = this.tab.content;
  }

  private allLocalConfirmed(): boolean {
    if (this.pushInFlight || this.queued !== null) return false;
    return !(this.binding?.hasPendingLocal() ?? false);
  }

  private checkFlushWaiters(): void {
    if (this.flushWaiters.length === 0) return;
    if (!this.ownsSaves()) {
      // Degraded/off mid-wait: resolve false so the save falls back to
      // the classic path instead of timing out.
      for (const w of this.flushWaiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(false);
      }
      return;
    }
    if (this.status !== "attached") return;
    if (!this.allLocalConfirmed() || this.serverDirty) {
      this.binding?.flushPendingLocal();
      return;
    }
    for (const w of this.flushWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(true);
    }
  }

  /// Repaint collaborator name flags after a roster change (names
  /// resolve through the session roster; a rename swaps flag text).
  notifyRosterChanged(): void {
    this.binding?.collaboratorsChanged();
  }

  // ---- teardown --------------------------------------------------------

  private destroy(): void {
    this.closedByUs = true;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.clearReconnectTimer();
    this.clearAttachTimer();
    this.clearCursorTimer();
    for (const w of this.flushWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    this.closeSocket();
    this.binding = null;
    this.cursors.clear();
    registry.delete(this.tabId);
    setTabDocState(this.tab, null);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearAttachTimer(): void {
    if (this.attachTimer !== null) clearTimeout(this.attachTimer);
    this.attachTimer = null;
  }

  private clearCursorTimer(): void {
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }
}

// ---- registry --------------------------------------------------------------

/// Acquire (or re-acquire within the release linger) the scene session
/// for `tab`. Returns null when scene sync is off, unsupported, or the
/// buffer is over the size gate; the caller then simply has no session
/// and the classic paths run.
export function acquireSceneSession(tab: FileTab): SceneSession | null {
  if (!sceneSyncEnabled()) return null;
  // Size gate read untracked on purpose: eligibility must not re-run
  // the acquire effect per stroke. Growth past the server's byte limit
  // mid-session is rejected loudly by the authority instead.
  if (tab.content.length > SCENE_MAX_LEN) return null;
  const existing = registry.get(tab.id);
  if (existing) {
    if (existing.path === tab.path) {
      existing.retain();
      return existing;
    }
    existing.release({ immediate: true });
  }
  const session = new SceneSession(tab);
  registry.set(tab.id, session);
  return session;
}

/// Release the session for `tabId`. Lingers by default (canvas remount);
/// immediate for tab close, rename rekey, and file discard.
export function releaseSceneSession(
  tabId: string,
  opts?: { immediate?: boolean },
): void {
  registry.get(tabId)?.release(opts);
}

export function sceneSessionFor(tabId: string): SceneSession | undefined {
  return registry.get(tabId);
}

/// Roster hook: after a `session_roster` snapshot applies, repaint every
/// bound canvas's collaborator flags.
export function sceneSyncRosterChanged(): void {
  for (const s of registry.values()) s.notifyRosterChanged();
}

/// Test seam: drop every session and reset the module-wide capability
/// latch. Never called in production.
export function resetSceneSyncForTests(): void {
  for (const s of [...registry.values()]) s.release({ immediate: true });
  registry.clear();
  serverSupportsSceneSync = null;
}

// ---- tabs.svelte.ts hooks ---------------------------------------------------
// Registered at module load (FileEditorTab imports this module with the
// canvas); the shared slots are arrays, so doc and scene sessions coexist
// and each delegate answers "classic" for tabs it does not own.

registerLiveSessionKind({
  async save(t: FileTab) {
    const session = registry.get(t.id);
    if (!session || !session.ownsSaves()) return "classic";
    if (await session.flush()) return "saved";
    session.degrade();
    // Single-writer handoff: the degrade gated the pump; wait out any
    // push already on the wire before the classic PUT fires so the two
    // writers never interleave and the freshest ack token is on the
    // tab when the PUT stamps its CAS check.
    await session.awaitPushSettled();
    return "degraded";
  },
  release(tabId: string, immediate: boolean) {
    releaseSceneSession(tabId, { immediate });
  },
  savePaused(tabId: string) {
    return registry.get(tabId)?.isOutagePaused() ?? false;
  },
  unflushed(tabId: string) {
    return registry.get(tabId)?.hasUnflushedState() ?? false;
  },
  fallbackSaved(tabId: string) {
    registry.get(tabId)?.healAfterFallbackSave();
  },
});

// Hybrid Nav settles by swapping the whole tree, which replaces the tab
// object every live session mirrors onto. Re-apply each mirror against the
// tree that won, whether that was the draft (commit) or the live one
// (cancel, where this is a no-op).
registerPaneModeSettledSink(() => {
  for (const session of registry.values()) session.resyncMirror();
});
