/// Live Excalidraw scene sessions: the client half of chan-server's
/// per-scene authority (`/api/scene/ws`). While a canvas tab is ATTACHED,
/// the server owns the scene and disk; local changes ride element-level
/// pushes (the authority merges by Excalidraw's version/versionNonce rule
/// and fans accepted values to the other attachments), remote changes
/// arrive as `update` frames the canvas reconciles, and saves become
/// flush confirmations instead of PUTs. When the channel is unavailable
/// the tab degrades to the classic autosave + CAS path with the last
/// flush token, once no unresolved push can race that replacement.
///
/// One SceneSession per TAB (not per path), mirroring docSync: the
/// session outlives canvas remounts (cross-pane move) via a short release
/// linger. Unlike docSync there is no CodeMirror shadow/rebase machinery:
/// the canvas IS the local state, remote content applies through
/// `reconcileElements`, and the session's shadow of the scene (its elements,
/// appState and files) is what a canvas that binds after the frames landed
/// is replayed, with the appState keys this window picked laid over the
/// shadow's. That appState is also the one a push lays those keys over, as
/// the push goes on the wire.
///
/// The canvas half plugs in through [`SceneCanvasBinding`]
/// (ExcalidrawCanvas.svelte implements it): the session drives the
/// binding from socket callbacks and the binding hands local deltas to
/// [`SceneSession.pushScene`]. Saved-state semantics are ack-based:
/// `tab.saved` advances to `tab.content` whenever a `push-ok` lands with
/// nothing left unpushed, and whenever the canvas mirrors its board into
/// the buffer while attached with nothing of its own unconfirmed, as after a
/// peer's edit, and again when Hybrid Nav settles on the tab that won,
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
import { readStorageFlag } from "./storage";
import { windowCaps } from "./windowCaps";
import {
  liveFileTabById,
  markTabFileMissing,
  clearUnresolvedLiveSave,
  registerLiveSessionKind,
  registerPaneModeSettledSink,
  setTabDocState,
  withholdUnresolvedLiveSave,
  type DocSyncStatus,
  type FileTab,
  type PushSettlement,
} from "./tabs.svelte";

/// Feature flag. Default ON; localStorage `chan.scenesync = "0"` opts a
/// browser out, and the capability probe below silently turns everything
/// off against a pre-scene-sync server.
const SCENESYNC_FLAG_KEY = "chan.scenesync";
const SCENESYNC_DEFAULT_ON = true;

/// Keep the socket + shadow alive briefly after the owning canvas
/// releases; a cross-pane tab move is a full component remount and the
/// linger carries the session across the swap.
const SCENE_RELEASE_LINGER_MS = 250;

/// Reconnect grace, mirroring docSync: a socket drop shows as
/// `reconnecting` (classic autosave stays suppressed) for at most this
/// many attempts / this long, then the session degrades. Classic saves
/// resume only when no old push outcome remains unresolved; background
/// retries continue at capped backoff.
const SCENE_RECONNECT_GRACE_ATTEMPTS = 2;
const SCENE_RECONNECT_GRACE_MS = 3000;

/// A dial that produces no frame within this window counts as a failed
/// attempt.
export const SCENE_ATTACH_TIMEOUT_MS = 5000;

/// A socket awaiting its snapshot has this long after the hello before
/// classic saves resume. Thirty seconds carries about 2 MiB at 0.56 Mbit/s
/// while bounding a stalled attach that would otherwise withhold saves.
export const SCENE_SNAPSHOT_TIMEOUT_MS = 30_000;

/// Ceiling on a save-funnel flush await; covers the authority's ~800ms
/// flush debounce plus the write with margin.
export const SCENE_FLUSH_TIMEOUT_MS = 4000;

/// Bound on waiting for a push before considering a classic fallback.
/// Expiry leaves that fallback withheld until the push is acknowledged
/// or a fresh session snapshot reconciles it.
export const SCENE_FALLBACK_SETTLE_MS = 2000;

/// Outbound pointer cadence: trailing-edge throttle on pointer moves,
/// applied inside the session so every binding inherits it.
const SCENE_CURSOR_THROTTLE_MS = 100;

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
  return readStorageFlag(SCENESYNC_FLAG_KEY, SCENESYNC_DEFAULT_ON);
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
  // Draft close/promote interleaves saves with file moves, so a draft
  // is excluded.
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
  /// The first message of an accepted upgrade, which a server sends before
  /// it attaches the session. `onFrame` has no arm for it: as a socket's
  /// first frame it sets the latch, ends the attach window and starts the
  /// snapshot bound. A slow attach is not read as a dial that failed.
  | { type: "hello" }
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
  /// `changed` says whether the push changed the authority's scene. The
  /// authority acks a push that changed nothing the same way and writes
  /// nothing after it, so only a true leaves the file behind the scene.
  | { type: "push-ok"; version: number; changed?: boolean }
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

/// The save line of a save refused for want of a board: the authority has
/// not said the file holds the scene, whether the save's wait ran out or the
/// session cannot ask, and no canvas is bound to save it from. It follows
/// "Not saved:" on the toolbar and "was not saved because" in a close's
/// question.
const UNBOUND_FALLBACK_REASON =
  "the server has not confirmed writing it, and this tab has no board open to save it from";

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
  /// appState is the authority's with the keys of this window's claim laid
  /// over it. It is left out while a push of this window's that sends an
  /// appState is on the wire: the authority holds that one once it has
  /// applied the push, and the board already shows it. A key the board
  /// changed and has not offered yet is in no claim: the canvas keeps it over
  /// the handed appState while `keepsAppStateClaim` answers true, and offers
  /// it at its next flush.
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
  /// both away. It takes the elements and the files `pushScene` did, because
  /// the canvas marks both on a true and a mark left in place keeps its part
  /// out of every later push: an element stays on the canvas having reached
  /// nobody, and a file leaves the authority holding an element that
  /// references bytes it does not have. An appState is not handed back: the
  /// session keeps it as this window's claim and offers it again itself.
  forgetBroadcast(elements: WireElement[], files?: WireFiles): void;
};

// ---- session ---------------------------------------------------------------

const registry = new Map<string, SceneSession>();

/// The appState claim a session held when it was torn down, kept for the
/// session its tab acquires next. A rename releases the session of the old
/// path at once and the tab's host acquires one for the new path in the same
/// flush, and the pick no authority confirmed follows the tab there, as its
/// unpushed elements do, which the board keeps and offers to the session it
/// binds next. An entry lasts as long as a release lingers, so the claim of a
/// tab that closed goes with it.
const handedOnClaims = new Map<string, { claim: WireAppState; timer: ReturnType<typeof setTimeout> }>();

function handOnClaim(tabId: string, claim: WireAppState): void {
  takeHandedOnClaim(tabId);
  handedOnClaims.set(tabId, {
    claim,
    timer: setTimeout(() => handedOnClaims.delete(tabId), SCENE_RELEASE_LINGER_MS),
  });
}

function takeHandedOnClaim(tabId: string): WireAppState | null {
  const handed = handedOnClaims.get(tabId);
  if (!handed) return null;
  clearTimeout(handed.timer);
  handedOnClaims.delete(tabId);
  return handed.claim;
}

/// Coalesced outbound state while a push is in flight: later local
/// deltas for the same element replace earlier ones (the canvas already
/// carries the newest version), appState replaces wholesale, files
/// accumulate.
type QueuedPush = {
  elements: Map<string, WireElement>;
  /// The appState the push sends: the scene's whole, since the authority
  /// replaces its own with a push's. A push still queued has it built again
  /// as it goes on the wire (`drainQueued`), over the authority's as it is
  /// then; until then this says only that the push sends one.
  appState: WireAppState | null;
  /// The keys of this window's appState claim the push carries, which its
  /// ack confirms. For a push on the wire they are in the appState it sent.
  /// For a queued one they are what the drain lays over the authority's
  /// appState: every offer that joined the queue added its keys, and none
  /// is dropped while the push waits unless a conflict resolution takes
  /// the disk or Restore replaces a board that adopted no live scene.
  /// Both end the claim and empty the push's appState (`endAppStateClaim`).
  claim: WireAppState | null;
  files: WireFiles | null;
};

/// What a push claimed, so the wire payload and the coalesced one are one
/// type and the hand-back cannot cover one part of a claim and miss another.
function claimedPush(
  elements: WireElement[],
  appState: WireAppState | undefined,
  files: WireFiles | undefined,
  claim: WireAppState | null = null,
): QueuedPush {
  const byId = new Map<string, WireElement>();
  for (const el of elements) {
    const id = el.id;
    if (typeof id === "string") byId.set(id, el);
  }
  return { elements: byId, appState: appState ?? null, claim, files: files ?? null };
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
  /// Holds the first-frame timer, then the post-hello snapshot timer.
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  private binding: SceneCanvasBinding | null = null;
  /// Whether the canvas bound last has adopted this session's scene, at its
  /// bind's replay or at a snapshot applied since. One bound before the
  /// current socket's snapshot shows the buffer it seeded from until that
  /// snapshot lands: it holds nothing a peer made, so it has no authority to
  /// reach, while a key its user picks there is a claim like any other.
  private canvasAdopted = false;

  /// The scene replayed into a canvas that binds after the frames landed:
  /// snapshot and update frames, plus this window's own pushes, each with
  /// all three of its parts, taken when `pushScene` takes the push. A replay
  /// is an adopt, so a part this left out would be adopted over the push:
  /// the older value would go on the board and never be offered again. A
  /// discarded push leaves its parts here until the next snapshot replaces
  /// them. Claims released without a bound canvas are retained separately
  /// so a later bind can offer them after that snapshot. The appState held
  /// here is the authority's as last known: a snapshot's, an update's, and
  /// the one a push of this window's sent once that push is acked. The
  /// scene's appState, which a replay hands a canvas and a push sends, is
  /// that one with this window's claim laid over it (`sceneAppState`).
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
  /// frames and from the ack of a push of this window's that changed the
  /// scene, so `flush()` can resolve immediately when there is nothing
  /// unflushed.
  private serverDirty = false;
  /// The save error this session wrote: for a flush the server could not
  /// make, or for a save it refused for want of a board. A flush that lands
  /// clears it, and only it: an error the classic save wrote stays until a
  /// save of that path clears it.
  private flushError: string | null = null;

  private pushInFlight = false;
  private pushOutcomeUnresolved = false;
  /// Fallback-settle waiters receive a positive result only after all
  /// queued pushes are acknowledged.
  private pushSettleWaiters: {
    resolve: (outcome: PushSettlement) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  /// The push currently on the wire, in the same three parts the queued one
  /// has, so a drop, or the next socket's first snapshot, can hand all of it
  /// back to the canvas: whether the authority read it is not known. Cleared
  /// by the ack.
  private unacked: QueuedPush | null = null;
  private queued: QueuedPush | null = null;
  /// Elements and files released without a canvas survive until a new
  /// canvas can replay and offer them after the next socket's snapshot.
  private unboundClaims: QueuedPush | null = null;
  /// The appState keys this window changed that no authority has confirmed,
  /// each with the value picked, and null with none. A canvas offers
  /// `pushScene` the keys its user changed, and they join the claim whether
  /// that push went on the wire, was queued behind one or was refused. An
  /// appState key has no version, so nothing but this claim can offer it
  /// again. The claim stands across a drop and a redial, and its keys are
  /// laid over the authority's appState in what a canvas is handed and in
  /// what a push sends: this window's value stands for each key it picked,
  /// over a peer's change of it made meanwhile, and a peer's value for every
  /// other key. It rides the next push the session takes and ends at the
  /// push-ok of the push that carried it, unless a key joined it since, or
  /// when the session stops retrying. While it stands the tab reads unsaved.
  /// Each offer makes a new object, so a push tells the claim it carried
  /// from a later one by identity. A session starts with the claim its tab's
  /// last session held when it was torn down, if one was handed on.
  private appStateClaim: WireAppState | null = null;

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
    this.appStateClaim = takeHandedOnClaim(tab.id);
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

  /// Whether the bound board holds this session's scene and its authority
  /// can still be reached: the board has adopted a snapshot of the session,
  /// and the session has not been released and has not stopped retrying, as
  /// it does when the server lacks scene sync, closes the session for good
  /// or answers a permanent error. A degraded session that keeps redialing
  /// has one. A board that has adopted nothing has none: before any frame,
  /// after a frame that is no snapshot (the hello a server opens the socket
  /// with, an error it sends before it closes the socket), and when it bound
  /// before its socket's snapshot, it holds the buffer's scene and nothing a
  /// peer made.
  reachesAuthority(): boolean {
    return this.canvasAdopted && !this.closedByUs && !this.retryStopped;
  }

  /// The tab turned read only, which its host reports. A read-only tab
  /// pushes nothing, so no ack can end an appState claim it holds, and while
  /// the claim stood, a peer's value for its keys would stay off the board
  /// and the tab would read unsaved for as long as read mode lasts. The
  /// claim is dropped, and a board that shows it takes the scene's appState
  /// without it. A key that a push on the wire or queued carries is still
  /// in that appState and stays on the board: its push goes out whatever
  /// the tab's mode, and the authority then holds the key.
  tabTurnedReadOnly(): void {
    if (this.appStateClaim === null || !this.isReadOnlyAttach()) return;
    this.appStateClaim = null;
    if (this.canvasAdopted) this.binding?.applyUpdate({ elements: [], appState: this.sceneAppState() });
  }

  /// A conflict resolution can take the disk without loading a new tab;
  /// Restore can replace a board that adopted no live scene. Either drops
  /// appState choices made on the scene the tab leaves: its claim ends and
  /// a push still queued sends no appState. A push on the wire is the
  /// authority's to answer.
  endAppStateClaim(): void {
    this.appStateClaim = null;
    if (this.queued !== null) {
      this.queued.appState = null;
      this.queued.claim = null;
    }
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
  /// waiting behind it, an appState claim no authority has confirmed, or an
  /// authority that has taken changes it has not flushed. The force-reload
  /// prompt keys on this, because for an
  /// attached canvas `content === saved` only means the authority took
  /// the elements, never that they reached the file.
  ///
  /// It over-reports for a degraded session: the deltas the canvas still
  /// holds are the bytes the classic PUT already wrote, so the prompt warns
  /// about a tab that is fully on disk. That is the safe direction for a
  /// prompt that guards a discard, and the alternative reads the save path
  /// from here to learn which of the two wrote last.
  hasUnflushedState(): boolean {
    if (this.serverDirty || this.pushOutcomeUnresolved || !this.nothingClaimed()) return true;
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
    this.canvasAdopted = false;
    this.retireUnboundRefusal();
    if (this.haveSnapshot) {
      const recoveringClaims = this.unboundClaims !== null;
      this.replayToBinding(binding, [...this.shadowElements.values()], this.sceneAppState(), this.shadowFiles);
      // A save may have degraded the session while no canvas existed. The
      // current socket's snapshot is already authoritative, so the rebound
      // canvas can resume its push after the replay.
      if (recoveringClaims) this.promoteIfChannelUp();
      binding.flushPendingLocal();
      this.finishDeferredReplay();
      this.offerAppStateClaim();
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
  /// that stayed local.
  ///
  /// `appState` is the exception. It holds the keys this window changed,
  /// and the session keeps them as this window's claim from this call on,
  /// whether or not it takes the push, so the caller marks them as handed
  /// over on either answer. That holds for a canvas bound before the first
  /// snapshot or between two sockets too: a canvas offers only the keys its
  /// user changed against what it seeded with, so the claim is a pick, laid
  /// over the snapshot when it lands and pushed after it. Two sessions keep
  /// none: one that has stopped retrying, or whose tab is read only, has no
  /// authority to confirm a claim. A push the session takes carries the
  /// claim when none on the wire or queued does.
  pushScene(elements: WireElement[], appState?: WireAppState, files?: WireFiles): boolean {
    if (appState !== undefined && this.keepsAppStateClaim()) {
      this.appStateClaim = { ...this.appStateClaim, ...appState };
    }
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
    // The authority replaces its appState with a push's, so a push that
    // offers keys, or takes along a claim no push carries yet, sends the
    // scene's whole appState with them laid over it.
    const sent =
      appState !== undefined || this.uncarriedAppStateClaim() !== null
        ? { ...this.sceneAppState(), ...appState }
        : undefined;
    for (const el of elements) this.foldIntoShadow(el);
    if (files !== undefined) this.shadowFiles = { ...this.shadowFiles, ...files };
    if (this.pushInFlight) {
      const q = this.queued ?? claimedPush([], undefined, undefined);
      for (const el of elements) {
        const id = el.id;
        if (typeof id === "string") q.elements.set(id, el);
      }
      if (sent !== undefined) {
        q.appState = sent;
        // An offer that joins a queued push adds to the keys that push
        // carries and drops none: a key the session's claim lost meanwhile
        // (its tab turned read only and back) is still on the board and
        // still this push's to send. The two are one object again, so the
        // push's ack ends the claim.
        if (q.claim !== null) this.appStateClaim = { ...q.claim, ...this.appStateClaim };
        q.claim = this.appStateClaim;
      }
      if (files !== undefined) q.files = { ...(q.files ?? {}), ...files };
      this.queued = q;
      return true;
    }
    this.pushInFlight = true;
    this.pushOutcomeUnresolved = true;
    this.unacked = claimedPush(elements, sent, files, sent !== undefined ? this.appStateClaim : null);
    this.send({
      type: "push",
      elements,
      ...(sent !== undefined ? { appState: sent } : {}),
      ...(files !== undefined ? { files } : {}),
    });
    return true;
  }

  /// The canvas has mirrored its board into the tab's buffer. A mirror that
  /// follows a peer's edit or an ack carries nothing of this window's that
  /// the authority has not acknowledged, and no push-ok comes for it; one
  /// that carries a local change finds that change pending or on the wire
  /// and leaves the mark to its push-ok. Only an attached session owns the
  /// mark: a degraded one's buffer is the classic save's, and a connecting
  /// or reconnecting one has no snapshot of this socket yet.
  bufferMirrored(): void {
    if (this.status !== "attached") return;
    this.confirmSaved();
    // A clean fresh snapshot can settle an old push without a later flush.
    if (!this.serverDirty && !this.pushOutcomeUnresolved && this.allLocalConfirmed() &&
        this.tab.content === this.tab.saved) {
      clearUnresolvedLiveSave(this.tab);
    }
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
  /// authority and the authority has flushed to disk. A timeout or flush
  /// error degrades the session; fallback still needs a settled push.
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

  /// Whether a save the authority has not answered must leave the file alone,
  /// saying so on the tab's save line when a flush's own error has not.
  ///
  /// With no canvas bound, nothing mirrors a board into the tab's buffer: a
  /// drawing tab restored and never shown, or a board whose library never
  /// reported its init, holds the text of its load. The session goes on
  /// stamping the authority's version and flush mtime on the tab all the
  /// same, so a classic write of that buffer would pass the server's check,
  /// and its replace deletes every element the text lacks, a peer's later
  /// edit among them. That is so in every state of the session, so the save
  /// writes nothing whether or not the session owns saves: one that does is
  /// asked again by the next save, and one that is degraded or off answers
  /// the same until a board binds or the session is released.
  ///
  /// A push of this window's with no known outcome is not this case: a
  /// canvas made it, and the settle wait and its withheld fallback own it.
  ///
  /// Only a registered session is asked: a released one speaks for no tab.
  refusesFallback(): boolean {
    if (this.binding !== null || this.pushOutcomeUnresolved) return false;
    if (this.flushError === null) {
      this.flushError = UNBOUND_FALLBACK_REASON;
      this.tab.saveError = this.flushError;
    }
    return true;
  }

  /// Take the unbound refusal's reason off the save line once it has stopped
  /// being true: a board has bound, the authority says the file holds the
  /// scene, or this session is no longer the tab's. A flush frame retires it
  /// as it does a flush's own error.
  private retireUnboundRefusal(): void {
    if (this.flushError !== UNBOUND_FALLBACK_REASON) return;
    if (this.tab.saveError === this.flushError) this.tab.saveError = null;
    this.flushError = null;
  }

  /// A bounded wait cannot turn silence or socket closure into an ack.
  awaitPushSettled(timeoutMs: number = SCENE_FALLBACK_SETTLE_MS): Promise<PushSettlement> {
    if (!this.pushOutcomeUnresolved) return Promise.resolve("settled");
    if (!this.pushInFlight) return Promise.resolve("unresolved");
    return new Promise<PushSettlement>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.pushSettleWaiters = this.pushSettleWaiters.filter(
            (w) => w !== waiter,
          );
          resolve("unresolved");
        }, timeoutMs),
      };
      this.pushSettleWaiters.push(waiter);
    });
  }

  /// Recheck after the wait's microtask: an ack, redial or new push can
  /// change ownership between the timer firing and the delegate resuming.
  fallbackSettlement(): PushSettlement {
    return this.pushOutcomeUnresolved || this.ownsSaves() ? "unresolved" : "settled";
  }

  /// Only an ack permits fallback. A lost socket or a new sync epoch
  /// releases the bounded wait without claiming that old push settled.
  private clearPushInFlight(outcome: PushSettlement): void {
    this.pushInFlight = false;
    if (outcome === "settled") {
      this.pushOutcomeUnresolved = false;
      this.tab.unresolvedLivePush = false;
    } else if (this.pushOutcomeUnresolved) {
      withholdUnresolvedLiveSave(this.tab);
    }
    for (const w of this.pushSettleWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(outcome);
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
  ///
  /// The saved mark needs the same. While the draft is up the board mirrors
  /// into the draft's tab and this session marks the layout's, whose buffer
  /// is the one the mode was entered with, so the commit puts the draft's
  /// buffer over a saved text that mark never reached. The tab would read
  /// unsaved, and refuse its close, until the next mirror or ack. The mark
  /// is derived again here from what the session holds now, as a mirror
  /// derives it. Only under a bound canvas: with none, nothing mirrors a
  /// board into the buffer and the session cannot speak for it.
  resyncMirror(): void {
    this.mirror();
    if (this.binding !== null) this.bufferMirrored();
  }

  /// Tear the session down. `linger` keeps the socket + shadow alive for
  /// SCENE_RELEASE_LINGER_MS so a canvas remount (cross-pane move) can
  /// re-acquire; an immediate release (tab close, rename rekey, file
  /// discard) detaches now, which also tells the server to flush
  /// promptly. A release made while the tab loads ends the appState claim.
  release(opts?: { immediate?: boolean }): void {
    // A tab that reads its file again puts the file in the place of the
    // buffer a claim was picked on, so the claim ends with that buffer: the
    // session its host acquires again inside the linger replays none of it.
    if (this.tab.loading) this.appStateClaim = null;
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

  /// Return unacknowledged elements and files to the canvas, or retain them
  /// until one binds. The authority may have read the wire payload; socket
  /// closure does not establish its outcome. Called at close and at the next
  /// socket's first snapshot. The appState of a discarded push stays this
  /// window's claim.
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
    if (elements.length === 0 && files === undefined) return;
    if (this.binding) {
      this.binding.forgetBroadcast(elements, files);
    } else {
      const claims = this.unboundClaims ?? claimedPush([], undefined, undefined);
      for (const el of elements) {
        if (typeof el.id === "string") claims.elements.set(el.id, el);
      }
      if (files !== undefined) claims.files = { ...(claims.files ?? {}), ...files };
      this.unboundClaims = claims;
    }
  }

  private replayToBinding(
    binding: SceneCanvasBinding,
    elements: WireElement[],
    appState: WireAppState | undefined,
    files: WireFiles,
  ): void {
    const claims = this.unboundClaims;
    // The canvas counts as having adopted once the apply has run.
    if (claims === null) {
      binding.applySnapshot(elements, appState, files);
      this.canvasAdopted = true;
      binding.collaboratorsChanged();
      return;
    }
    const replayElements = new Map(elements.map((el) => [el.id as string, el]));
    const replayFiles = { ...files };
    const pendingElements: WireElement[] = [];
    const pendingFiles: WireFiles = {};
    for (const el of claims.elements.values()) {
      const stored = replayElements.get(el.id as string);
      if (stored && (storedElementWins(stored, el) ||
          (stored.version === el.version && stored.versionNonce === el.versionNonce))) continue;
      replayElements.set(el.id as string, el);
      this.foldIntoShadow(el);
      pendingElements.push(el);
    }
    for (const [id, file] of Object.entries(claims.files ?? {})) {
      if (id in replayFiles) continue;
      replayFiles[id] = file;
      this.shadowFiles[id] = file;
      pendingFiles[id] = file;
    }
    binding.applySnapshot([...replayElements.values()], appState, replayFiles);
    this.canvasAdopted = true;
    binding.collaboratorsChanged();
    binding.forgetBroadcast(
      pendingElements,
      Object.keys(pendingFiles).length > 0 ? pendingFiles : undefined,
    );
    if (pendingElements.length === 0 && Object.keys(pendingFiles).length === 0) {
      this.unboundClaims = null;
      this.pushOutcomeUnresolved = false;
      this.tab.unresolvedLivePush = false;
    }
  }

  private finishDeferredReplay(): void {
    if (this.unboundClaims !== null && this.pushInFlight) this.unboundClaims = null;
  }

  /// This window's appState claim when no push on the wire or queued carries
  /// it, and null otherwise.
  private uncarriedAppStateClaim(): WireAppState | null {
    const carried = this.queued?.claim ?? this.unacked?.claim ?? null;
    return this.appStateClaim === carried ? null : this.appStateClaim;
  }

  /// The appState of this window's push on the wire, which the authority
  /// holds once it has applied that push, and null with none. A queued push
  /// is not on the wire: what the authority holds until it goes out is what
  /// that push's appState is laid over.
  private wireAppState(): WireAppState | null {
    return this.unacked?.appState ?? null;
  }

  /// The scene's appState: the authority's, or the one it will hold for a
  /// push of this window's on the wire, with the keys of the claim a queued
  /// push carries and of this window's claim laid over it.
  private sceneAppState(): WireAppState {
    const held = this.wireAppState() ?? this.shadowAppState;
    return { ...held, ...this.queued?.claim, ...this.appStateClaim };
  }

  /// Push this window's appState claim when no push carries it. Called once a
  /// snapshot has been applied and the canvas has pushed what it holds, at a
  /// bind's replay, and while a save waits. Elements and files that wait for
  /// a canvas go out in that canvas's push, which carries the claim with
  /// them, so with those waiting this sends nothing.
  private offerAppStateClaim(): void {
    if (this.unboundClaims !== null || this.uncarriedAppStateClaim() === null) return;
    this.pushScene([]);
  }

  /// Whether a key the bound canvas offers now is kept as this window's
  /// claim (see `pushScene`): it is while the session still retries and its
  /// tab is writable, before the canvas's first adopt as after it. A canvas
  /// asks at an adopt: a key its board changed and has not offered yet stays
  /// on the board through the handed appState exactly when its offer, had it
  /// come first, would have been kept.
  keepsAppStateClaim(): boolean {
    return !this.retryStopped && !this.isReadOnlyAttach();
  }

  /// A session that stops retrying has no authority left to confirm a claim.
  private stopRetrying(): void {
    this.retryStopped = true;
    this.appStateClaim = null;
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
    // The authority replaces its appState with this push's, and a peer's
    // change to another key may have reached it while the push waited. So
    // the appState is built here, over the authority's as it is at this ack,
    // with the claim the push carries laid over it.
    if (q.appState !== null) q.appState = { ...this.shadowAppState, ...q.claim };
    this.pushInFlight = true;
    this.pushOutcomeUnresolved = true;
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
    this.clearAttachTimer();
    if (this.pushInFlight) this.clearPushInFlight("unresolved");
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
        if (frame.type === "hello") {
          this.attachTimer = setTimeout(() => {
            console.warn("[chan] scene session: no snapshot after the hello, degrading", this.path);
            this.degrade();
          }, SCENE_SNAPSHOT_TIMEOUT_MS);
        }
      } else {
        this.clearAttachTimer();
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
    this.clearPushInFlight("unresolved");
    this.queued = null;
    if (this.closedByUs || this.retryStopped) return;
    // Capability probe: the first scene-ws connect that closes before
    // any frame means an old server; latch module-wide and go quiet.
    if (serverSupportsSceneSync === null && !this.sawFrameOnSocket) {
      serverSupportsSceneSync = false;
    }
    if (serverSupportsSceneSync === false) {
      this.setStatus("off");
      this.stopRetrying();
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
        // The authority writes the file after its debounce, so a push that
        // changed the scene leaves it dirty until the next flush frame. A
        // frame that says the push changed nothing, or does not say, leaves
        // the flag as it was: nothing is written after it, and a save held
        // on it would wait out its bound and fall back to the classic PUT.
        if (f.changed === true) this.serverDirty = true;
        this.pushInFlight = false;
        // The authority holds the appState its push sent, and the ack is its
        // answer for the claim that appState carried. A claim that a key
        // joined since is another and stands.
        if (this.unacked?.appState != null) this.shadowAppState = this.unacked.appState;
        if (this.unacked?.claim != null && this.unacked.claim === this.appStateClaim) {
          this.appStateClaim = null;
        }
        this.unacked = null;
        this.drainQueued();
        // A push the ack drains from the queue is on the wire in its
        // turn, and a fallback save waits for it too.
        if (!this.pushInFlight) this.clearPushInFlight("settled");
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
          this.stopRetrying();
          this.degrade();
        }
        // The server closes the socket after an error frame; transient
        // reasons recover through the reconnect + snapshot path.
        return;
      case "closed":
        // Registry-initiated teardown (storage reset, shutdown): stop
        // for good, classic behaviors resume.
        this.stopRetrying();
        this.setStatus("off");
        this.releaseUnaccepted();
        this.clearPushInFlight("unresolved");
        this.queued = null;
        this.closeSocket();
        return;
    }
  }

  private onSnapshot(f: Extract<ServerFrame, { type: "snapshot" }>): void {
    // The server fans a later snapshot on a socket that had its own when a
    // conflict's resolution leaves the scene unchanged or overwrites the
    // disk. A push this window sent on that socket and the server has not
    // acked is read after it, applied after it and acked on the same socket,
    // so a later snapshot ends none of them: they stay claimed and their parts
    // stay in the scene over the snapshot's but for an element the authority
    // keeps against them.
    //
    // The same holds for an appState a push on the wire sends: the authority
    // holds it once the push is applied, so the board keeps what it shows
    // and is handed none. With none on the wire, the board is handed the
    // snapshot's appState with the keys of this window's claim laid over it,
    // whichever snapshot this is: a push still queued sends its appState
    // over the snapshot's, and a claim no push carries is pushed once the
    // snapshot has been applied.
    const later = this.ws !== null && this.snapshotSocket === this.ws;
    this.shadowElements = new Map();
    for (const el of f.elements) this.foldIntoShadow(el);
    this.shadowAppState = f.appState;
    this.shadowFiles = f.files;
    this.snapshotSocket = this.ws;
    this.tab.authorityVersion = f.version;
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
    } else {
      // A socket's first snapshot opens a fresh sync epoch: a push still
      // claimed was sent on an earlier socket and is never acked on this
      // one. Hand its elements and files back before dropping them;
      // `applySnapshot` below marks those the authority holds, so only those
      // it lacks are offered again.
      this.releaseUnaccepted();
      this.clearPushInFlight("unresolved");
      this.pushOutcomeUnresolved = this.unboundClaims !== null;
      this.tab.unresolvedLivePush = this.pushOutcomeUnresolved;
      this.queued = null;
    }
    this.serverDirty = f.dirty;
    if (!f.dirty) this.retireUnboundRefusal();
    this.stampMtime(f.mtime_ns ?? null);
    this.cursors.clear();
    for (const c of f.cursors) {
      this.cursors.set(c.id, { w: c.w, x: c.x, y: c.y, tool: c.tool, selected: c.selected });
    }
    this.mirror();
    if (this.binding) {
      this.replayToBinding(
        this.binding,
        f.elements,
        this.wireAppState() !== null ? undefined : this.sceneAppState(),
        f.files,
      );
    }
    this.promoteIfChannelUp();
    // Locally-newer elements survive the canvas reconciliation and must
    // reach the authority (offline-edit and reattach cases). This runs
    // AFTER the promotion because `pushScene` refuses to send while the
    // session is degraded, and a snapshot landing on a degraded session is
    // exactly the reattach this rescue exists for.
    this.binding?.flushPendingLocal();
    this.finishDeferredReplay();
    this.offerAppStateClaim();
    this.checkFlushWaiters();
  }

  private onUpdate(f: Extract<ServerFrame, { type: "update" }>): void {
    this.tab.authorityVersion = f.version;
    // The authority applies a push after every update it fanned before the
    // push arrived, and replaces its appState with the push's. So while an
    // appState of this window's is on the wire, this update's stays out of
    // the scene and off the board, which keeps its own. With none on the
    // wire, the update's is the authority's: the board is handed it with the
    // keys of this window's claim laid over it, and a push still queued
    // sends its appState over it.
    const taken = f.appState !== undefined && this.wireAppState() === null;
    for (const el of f.elements) this.foldIntoShadow(el);
    if (taken) this.shadowAppState = f.appState!;
    if (f.files !== undefined) this.shadowFiles = { ...this.shadowFiles, ...f.files };
    this.serverDirty = true;
    this.binding?.applyUpdate({
      elements: f.elements,
      appState: taken ? this.sceneAppState() : undefined,
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
    if (!this.serverDirty && !this.pushOutcomeUnresolved && this.allLocalConfirmed() &&
        this.tab.content === this.tab.saved) {
      clearUnresolvedLiveSave(this.tab);
    }
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

  /// Nothing of this window's is queued, waits for a canvas or stands as an
  /// appState claim.
  private nothingClaimed(): boolean {
    return this.queued === null && this.unboundClaims === null && this.appStateClaim === null;
  }

  /// Ack-based saved semantics: with nothing local on the wire, queued,
  /// claimed or not yet handed over, the buffer holds no change of this
  /// window's that the authority has not acknowledged. It can still lag the
  /// authority, by a peer's edit the canvas's flush has not mirrored yet.
  private confirmSaved(): void {
    if (!this.allLocalConfirmed()) return;
    this.tab.saved = this.tab.content;
  }

  private allLocalConfirmed(): boolean {
    if (this.pushInFlight || !this.nothingClaimed()) return false;
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
      this.offerAppStateClaim();
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
    this.releaseUnaccepted();
    if (this.appStateClaim !== null) handOnClaim(this.tabId, this.appStateClaim);
    this.clearPushInFlight("unresolved");
    this.closeSocket();
    this.binding = null;
    this.cursors.clear();
    this.retireUnboundRefusal();
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
  for (const tabId of [...handedOnClaims.keys()]) takeHandedOnClaim(tabId);
  serverSupportsSceneSync = null;
}

// ---- tabs.svelte.ts hooks ---------------------------------------------------
// Registered at module load (FileEditorTab imports this module with the
// canvas); the shared slots are arrays, so doc and scene sessions coexist
// and each delegate answers "classic" for tabs it does not own.

registerLiveSessionKind({
  async save(t: FileTab) {
    const session = registry.get(t.id);
    if (!session) return "classic";
    // A session that has stopped owning saves leaves the buffer a bound
    // canvas mirrored to the classic write, and still holds one no canvas
    // wrote.
    if (!session.ownsSaves()) return session.refusesFallback() ? "refused" : "classic";
    if (await session.flush()) return "saved";
    // A release resolves the wait too. A session that is gone answers for
    // nothing on the tab: it writes no reason and mirrors no status, and
    // whatever released it owns the tab's next save.
    if (registry.get(t.id) !== session) return "refused";
    if (session.refusesFallback()) return "refused";
    session.degrade();
    // Degrade stops new pushes. Only an ack of every queued push permits
    // a classic PUT; the finite wait can end with that fallback withheld.
    await session.awaitPushSettled();
    return session.fallbackSettlement() === "settled" ? "degraded" : "unresolved";
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
  tookDisk(tabId: string) {
    registry.get(tabId)?.endAppStateClaim();
  },
});

// Hybrid Nav settles by swapping the whole tree, which replaces the tab
// object every live session mirrors onto. Re-apply each mirror against the
// tree that won. After a commit that is the draft's clone, which no session
// wrote to. After a cancel it is the live tree, where the status is the one
// the sessions wrote all along and the saved mark is derived again, as it is
// after a commit.
registerPaneModeSettledSink(() => {
  for (const session of registry.values()) session.resyncMirror();
});
