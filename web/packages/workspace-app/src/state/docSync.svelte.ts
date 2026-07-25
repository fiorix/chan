/// Live document sessions: the client half of chan-server's per-document
/// authority (`/api/doc/ws`). While a file tab is ATTACHED, the server owns
/// the document and disk; local edits ride `@codemirror/collab` update logs
/// (push at matching version, rebase on stale), remote edits arrive as
/// `updates` frames, and saves become flush confirmations instead of PUTs.
/// When the channel is unavailable the tab degrades to the classic
/// autosave + CAS path with a valid mtime token from the last `flush` frame.
///
/// One DocSession per TAB (not per path): two panes on the same file are two
/// attaches with independent clientIDs, exactly like two windows. The
/// session outlives editor remounts (mode toggle, cross-pane move) via a
/// short release linger; the confirmed shadow below is what a remounting
/// editor re-attaches against.
///
/// The CONFIRMED SHADOW `{doc, version}` is the client's copy of the
/// authority state, advanced by every `updates` frame (own echoes included)
/// and mirrored to `tab.saved` on every advance. That single choice makes
/// "dirty" mean "unconfirmed local edits", so every existing
/// `content !== saved` consumer (dots, close guards, `cs pane` flags) keeps
/// working with the correct meaning while attached.
///
/// Import cycle note: tabs.svelte.ts consumes this module only through the
/// registered hooks at the bottom (save delegate + release hook), so the
/// import edge points one way (docSync -> tabs) and the classic save path
/// works even if this module never loads.

import {
  ChangeSet,
  Compartment,
  Text,
  Transaction,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
} from "@codemirror/collab";
import { presentableDiff } from "@codemirror/merge";
import {
  clearPeersEffect,
  cursorFrameEffects,
  remoteCursorsField,
  removePeerEffect,
  rosterRestampEffects,
} from "../editor/collab/remoteCursors";
import {
  createSocket,
  withTokenQuery,
  WS_RECONNECT_BACKOFF_MIN_MS,
  WS_RECONNECT_BACKOFF_MAX_MS,
} from "../api/transport";
import { sessionWindowId } from "../api/client";
import { notify } from "./notify.svelte";
import { isDraftPath } from "./workspace.svelte";
import { isEditableText, isExcalidraw } from "./fileTypes";
import {
  markTabFileMissing,
  registerDocFallbackSavedHook,
  registerDocReleaseHook,
  registerDocSaveDelegate,
  registerDocSavePausedQuery,
  setTabDocState,
  type DocSyncStatus,
  type FileTab,
} from "./tabs.svelte";

/// Feature flag. Default ON (the server half is live); localStorage
/// `chan.docsync = "0"` opts a browser out, and the capability probe
/// below silently turns everything off against a pre-doc-sync server.
const DOCSYNC_FLAG_KEY = "chan.docsync";
const DOCSYNC_DEFAULT_ON = true;

/// Keep the socket + shadow alive briefly after the owning editor
/// releases. A cross-pane tab move is a full component remount
/// (Pane.svelte keeps tabs keyed by id, but a move destroys and
/// recreates FileEditorTab); the linger carries the session across
/// the swap so the move costs no resync.
export const DOC_RELEASE_LINGER_MS = 250;

/// Reconnect grace: a socket drop is shown as `reconnecting` (autosave
/// stays suppressed so a blip cannot fire a CAS PUT racing the
/// authority's flush) for at most this many attempts / this long,
/// after which the session degrades and classic autosave resumes.
/// Retries continue in the background at capped backoff; a later
/// successful reattach hard-resyncs and returns to `attached`.
export const DOC_RECONNECT_GRACE_ATTEMPTS = 2;
export const DOC_RECONNECT_GRACE_MS = 3000;

/// A dial that produces no frame within this window counts as a failed
/// attempt. Without it a hung upgrade would pin the tab in `connecting`
/// with autosave suppressed indefinitely.
export const DOC_ATTACH_TIMEOUT_MS = 5000;

/// Quiet-window ceiling on a save-funnel flush await: this long with NO
/// frame on the session degrades the save to the classic path. Any
/// progress frame (snapshot, updates, push-ok/-stale, flush) restarts
/// the window, so the deadline is RTT-agnostic: a slow-but-live channel
/// whose frames keep flowing never degrades mid-save, while a silent
/// one still covers the authority's ~800ms flush debounce with margin.
export const DOC_FLUSH_TIMEOUT_MS = 4000;

/// Absolute ceiling on a save-funnel flush await. A session that keeps
/// producing frames without ever confirming clean (peer edit storm,
/// wedged authority) must still fall through to the classic path.
export const DOC_FLUSH_CAP_MS = 30_000;

/// Bound on the degraded-fallback wait for an in-flight push to settle
/// before the classic PUT fires. Keeps the two writers serialized: the
/// push already on the wire lands (and its push-ok/flush frames restamp
/// the CAS token) before the PUT reads that token.
export const DOC_FALLBACK_SETTLE_MS = 2000;

/// Outbound cursor cadence: trailing-edge throttle on selection moves.
/// The presence field's freshness fade assumes roughly this rate.
export const DOC_CURSOR_THROTTLE_MS = 100;

/// Client-side mirror of the server's editable-text write limit
/// (TEXT_WRITE_LIMIT, 2 MiB). Compared against UTF-16 length as a cheap
/// lower bound; a doc that grows past the true byte limit mid-session is
/// rejected loudly by the authority and the session degrades.
const DOC_MAX_LEN = 2 * 1024 * 1024;

/// Capability probe: the FIRST doc-ws connect that closes before any
/// frame latches "unsupported" module-wide, so an old server costs one
/// failed dial total instead of a per-tab retry storm. `null` = unknown.
let serverSupportsDocSync: boolean | null = null;

/// True when doc sync should even be attempted for this page load.
export function docSyncEnabled(): boolean {
  if (serverSupportsDocSync === false) return false;
  if (typeof localStorage === "undefined") return false;
  try {
    const v = localStorage.getItem(DOCSYNC_FLAG_KEY);
    if (v === "0" || v === "off" || v === "false") return false;
    if (v === "1" || v === "on" || v === "true") return true;
  } catch {
    return false;
  }
  return DOCSYNC_DEFAULT_ON;
}

/// Whether `tab` qualifies for a live doc session. Reads exactly the
/// fields the acquire/release $effect should track: path, mode, loading,
/// fileMissing. Deliberately NOT content (size is checked untracked at
/// acquire time) and NOT readMode/fsWritable (read-only tabs still
/// attach, they just never send).
export function isDocSyncEligible(tab: FileTab): boolean {
  if (!docSyncEnabled()) return false;
  if (tab.loading || tab.fileMissing) return false;
  if (tab.mode !== "source" && tab.mode !== "wysiwyg") return false;
  if (!isEditableText(tab.path) || isExcalidraw(tab.path)) return false;
  // Draft close/promote interleaves saves with file moves; excluded v1.
  if (isDraftPath(tab.path)) return false;
  return true;
}

function freshClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/// Build the doc-ws path. `version` rides only on reconnects that can
/// take the incremental catch-up; a fresh attach omits it and gets a
/// snapshot.
export function docWsPath(path: string, windowId: string, version?: number): string {
  const params = new URLSearchParams({ path, w: windowId });
  if (version !== undefined) params.set("version", String(version));
  return `/api/doc/ws?${params.toString()}`;
}

function docWsUrl(path: string, version?: number): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const p = withTokenQuery(docWsPath(path, sessionWindowId(), version));
  return `${proto}//${window.location.host}${p}`;
}

/// LF-normalize for comparisons against CodeMirror docs (CM normalizes
/// any \r\n / \r on the way in; tab.content may still carry CRLF from a
/// disk read that predates the first edit).
function lf(s: string): string {
  return s.indexOf("\r") === -1 ? s : s.replace(/\r\n?/g, "\n");
}

// ---- wire frames (pinned contract; serde tag = "type") --------------------

type WireUpdate = { clientID: string; changes: unknown };

type ServerFrame =
  | {
      type: "snapshot";
      path: string;
      version: number;
      doc: string;
      dirty: boolean;
      mtime_ns: string | null;
      cursors: PeerCursorFrame[];
    }
  | { type: "updates"; version: number; updates: WireUpdate[] }
  | { type: "push-ok"; version: number }
  | { type: "push-stale"; version: number }
  | ({ type: "cursor" } & PeerCursorFrame)
  | { type: "cursor-gone"; id: number }
  | { type: "flush"; dirty: boolean; mtime_ns?: string | null; error?: string }
  | { type: "removed" }
  | { type: "error"; message: string; reason?: string }
  | { type: "closed"; reason?: string };

export type PeerCursorFrame = {
  /// Server attach id: unique per socket, NOT per window (two panes of
  /// one window attach separately).
  id: number;
  /// window_id, the roster key that resolves a display name.
  w: string;
  anchor: number;
  head: number;
  version: number;
};

/// Error reasons that must not trigger a reconnect loop (the retry
/// would fail identically): an attach the server refused outright
/// (bad path, missing file, non-editable, oversized) and a document
/// past the size limit. Transient reasons (bad-changeset,
/// malformed-frame, session-closed) recover through reconnect +
/// snapshot instead.
const PERMANENT_ERROR_REASONS = new Set(["attach-failed", "doc-too-large"]);

export type PeerCursor = {
  w: string;
  anchor: number;
  head: number;
  version: number;
};

/// Save-funnel waiter: `quietTimer` is the restartable no-frame window,
/// `capTimer` the absolute ceiling. Either firing resolves false.
type FlushWaiter = {
  resolve: (ok: boolean) => void;
  quietMs: number;
  quietTimer: ReturnType<typeof setTimeout>;
  capTimer: ReturnType<typeof setTimeout>;
};

// ---- session ---------------------------------------------------------------

const registry = new Map<string, DocSession>();

let nextSessionToken = 0;

export class DocSession {
  readonly tabId: string;
  readonly path: string;
  /// Stable per-session identity. A memoizing consumer keys its
  /// minted-once extension on `${token}:${mode}` so a reactive
  /// recompute returns the SAME extension reference (a fresh mint per
  /// recompute would re-run bindView -> tryAttach -> dispatch and storm
  /// microtasks). Changes only when the session is replaced.
  readonly token: number = (nextSessionToken += 1);
  private readonly tab: FileTab;

  private status: DocSyncStatus = "connecting";
  private ws: WebSocket | null = null;
  private sawFrameOnSocket = false;
  /// The attach timer closed this socket itself (no frame in time).
  /// Read once by onSocketClosed: a self-inflicted timeout close says
  /// nothing about server capability, unlike a server-initiated close.
  private attachDialTimedOut = false;
  private closedByUs = false;
  private retryStopped = false;
  private backoffMs = WS_RECONNECT_BACKOFF_MIN_MS;
  private reconnectAttempts = 0;
  private droppedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /// Confirmed shadow: the authority text/version as of the last frame.
  private shadowText: Text = Text.empty;
  private shadowVersion = 0;
  private haveSnapshot = false;
  /// Authority-side dirty flag, tracked from snapshot/updates/flush
  /// frames so `flush()` can resolve immediately when there is nothing
  /// unflushed.
  private serverDirty = false;

  private view: EditorView | null = null;
  private slot: Compartment | null = null;
  private collabInstalled = false;
  /// The attach readiness check failed (editor doc had not caught up to
  /// the buffer yet); retry on the next view update.
  private attachQueued = false;

  private pushInFlight = false;
  /// push-stale latch: the authority version our next push must reach
  /// before re-pushing (the missed broadcasts are already in flight on
  /// this socket).
  private staleLatch: number | null = null;

  private cursors = new Map<number, PeerCursor>();
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  private flushWaiters: FlushWaiter[] = [];

  /// Fallback-settle waiters: resolved the moment no push is in flight
  /// (or on their own bound). See awaitPushSettled.
  private pushSettleWaiters: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(tab: FileTab) {
    this.tabId = tab.id;
    this.path = tab.path;
    this.tab = tab;
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
  /// outage that is still retrying: the socket is down and background
  /// reconnects are live (`retryStopped` false). In that state a classic
  /// autosave PUT would hit the same unreachable server, fail, and its
  /// `tab.error` would swap the editor for the error placeholder -
  /// unmounting the collab view and losing the unconfirmed buffer. The
  /// save path suppresses the PUT + error here; the buffer stays in the
  /// live editor (and the localStorage editorBuffer) for the reattach
  /// diff-push. Deliberately FALSE when the socket is still open (a
  /// flush-timeout degrade against a reachable server - classic CAS PUT
  /// is correct there) and for every permanent stop (CRLF, doc-too-large,
  /// attach-failed, closed, capability-off - `retryStopped` true or a
  /// self-close - where the server is alive and classic errors belong).
  isOutagePaused(): boolean {
    if (this.retryStopped || this.closedByUs) return false;
    if (this.status !== "degraded") return false;
    return !(this.ws !== null && this.ws.readyState === WebSocket.OPEN);
  }

  peers(): number {
    const self = sessionWindowId();
    const windows = new Set<string>();
    for (const c of this.cursors.values()) {
      if (c.w !== self) windows.add(c.w);
    }
    return windows.size;
  }

  /// Snapshot of the peer cursor cache (for the presence layer).
  peerCursorSnapshot(): ReadonlyMap<number, PeerCursor> {
    return this.cursors;
  }

  /// Mint the per-editor-mount extension bundle. A FRESH Compartment per
  /// call: compartment-cycling is the only way to reseed collab's
  /// internal version on re-attach (re-adding while present dedupes and
  /// keeps the stale field), so the slot must never be shared across
  /// mounts. The ViewPlugin self-registers the mounting view; remounts
  /// need no imperative wiring from the host.
  extension(): Extension {
    const slot = new Compartment();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    return [
      slot.of([]),
      remoteCursorsField,
      ViewPlugin.define((view) => {
        // Defer past the view construction/update cycle: the attach
        // algorithm dispatches transactions, which is illegal from a
        // plugin constructor.
        queueMicrotask(() => session.bindView(view, slot));
        return {
          update(u) {
            if (u.docChanged) session.onViewDocChanged();
            if (u.selectionSet) session.onViewSelectionSet();
          },
          destroy() {
            session.unbindView(view);
          },
        };
      }),
    ];
  }

  /// Save-funnel entry: ensure every local edit is confirmed by the
  /// authority and the authority has flushed to disk. Resolves false
  /// when the channel goes quiet for `quietMs` (or DOC_FLUSH_CAP_MS in
  /// total) or on a flush error; the caller degrades the session and
  /// falls back to the classic PUT.
  flush(quietMs: number = DOC_FLUSH_TIMEOUT_MS): Promise<boolean> {
    if (!this.ownsSaves()) return Promise.resolve(false);
    this.maybePush();
    return new Promise<boolean>((resolve) => {
      const waiter: FlushWaiter = {
        resolve,
        quietMs,
        quietTimer: setTimeout(() => this.expireFlushWaiter(waiter), quietMs),
        capTimer: setTimeout(
          () => this.expireFlushWaiter(waiter),
          DOC_FLUSH_CAP_MS,
        ),
      };
      this.flushWaiters.push(waiter);
      this.checkFlushWaiters();
    });
  }

  /// A waiter's quiet window or absolute cap ran out: resolve false so
  /// the save degrades to the classic path.
  private expireFlushWaiter(w: FlushWaiter): void {
    const i = this.flushWaiters.indexOf(w);
    if (i === -1) return;
    this.flushWaiters.splice(i, 1);
    clearTimeout(w.quietTimer);
    clearTimeout(w.capTimer);
    w.resolve(false);
  }

  /// A progress frame arrived: restart every waiter's quiet window.
  /// This is what makes the funnel deadline RTT-agnostic (see
  /// DOC_FLUSH_TIMEOUT_MS).
  private noteFlushProgress(): void {
    for (const w of this.flushWaiters) {
      clearTimeout(w.quietTimer);
      w.quietTimer = setTimeout(() => this.expireFlushWaiter(w), w.quietMs);
    }
  }

  /// Resolve and clear every pending funnel waiter.
  private settleFlushWaiters(ok: boolean): void {
    for (const w of this.flushWaiters.splice(0)) {
      clearTimeout(w.quietTimer);
      clearTimeout(w.capTimer);
      w.resolve(ok);
    }
  }

  /// Drop to the classic autosave + CAS path. The last `flush` frame's
  /// mtime token is already stamped on the tab, so the next PUT's CAS
  /// check is correct, and the pump stops pushing (maybePush gates on
  /// this status) so the classic writer is the only writer. Recovery: a
  /// socket-down degrade heals through the background reconnects; a
  /// socket-open degrade heals through healAfterFallbackSave once a
  /// classic save lands.
  degrade(): void {
    if (this.status === "degraded" || this.status === "off") return;
    this.setStatus("degraded");
  }

  /// Fallback settle: resolves once no push is in flight, bounded by
  /// `timeoutMs`. The degrade gate in maybePush stops NEW pushes; this
  /// waits out the one already on the wire so the classic fallback PUT
  /// never interleaves with it, and so the push's own push-ok/flush
  /// frames get their chance to restamp the tab's CAS token before the
  /// PUT reads it.
  awaitPushSettled(timeoutMs: number = DOC_FALLBACK_SETTLE_MS): Promise<void> {
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

  /// A classic fallback save for this tab landed while the session sat
  /// degraded with the channel still up. Resync now: the fresh snapshot
  /// re-adopts the authority (the PUT divert just updated it) and the
  /// attach path promotes back to `attached`, restoring single-writer
  /// ownership instead of leaving the tab degraded-classic for the rest
  /// of its life. Socket-down degrades keep their background retry
  /// loop; permanent stops stay stopped.
  healAfterFallbackSave(): void {
    if (this.retryStopped || this.closedByUs) return;
    if (this.status !== "degraded") return;
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.hardResync();
  }

  /// Tear the session down. `linger` keeps the socket + shadow alive for
  /// DOC_RELEASE_LINGER_MS so an editor remount (cross-pane move) can
  /// re-acquire without a resync; an immediate release (tab close,
  /// rename rekey, file discard) detaches now, which also tells the
  /// server to flush promptly (detach sets flush_now server-side).
  release(opts?: { immediate?: boolean }): void {
    if (opts?.immediate) {
      this.destroy();
      return;
    }
    if (this.releaseTimer !== null) return;
    this.releaseTimer = setTimeout(() => this.destroy(), DOC_RELEASE_LINGER_MS);
  }

  /// Cancel a pending lingered release (the tab re-acquired).
  retain(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  // ---- editor binding --------------------------------------------------

  private bindView(view: EditorView, slot: Compartment): void {
    if (this.releaseTimer !== null) this.retain();
    this.view = view;
    this.slot = slot;
    this.collabInstalled = false;
    this.attachQueued = true;
    this.seedPeerField();
    this.tryAttach();
  }

  private unbindView(view: EditorView): void {
    if (this.view !== view) return;
    // Unconfirmed local updates die with the view's collab state; the
    // shadow stays at the confirmed version and tab.content retains the
    // full text, so the next bindView diff-pushes them as fresh edits.
    this.view = null;
    this.slot = null;
    this.collabInstalled = false;
    this.attachQueued = false;
    this.clearCursorTimer();
  }

  /// Re-seed a freshly-mounted editor's presence field from the peer
  /// cache (a remount starts from an empty field). Stale seeds paint
  /// carets without flashing name flags.
  private seedPeerField(): void {
    if (!this.view || this.cursors.size === 0) return;
    const effects: StateEffect<unknown>[] = [clearPeersEffect.of(null)];
    for (const [id, c] of this.cursors) {
      effects.push(
        ...cursorFrameEffects(
          { id, w: c.w, anchor: c.anchor, head: c.head },
          { fresh: false },
        ),
      );
    }
    this.view.dispatch({ effects });
  }

  private onViewDocChanged(): void {
    if (this.attachQueued) {
      // The editor may still be filling from the async load; retry the
      // readiness check now that the doc changed.
      queueMicrotask(() => this.tryAttach());
      return;
    }
    if (!this.collabInstalled) return;
    queueMicrotask(() => this.maybePush());
  }

  /// Outbound presence: trailing-edge throttle on selection moves,
  /// suppressed for read-only attaches. Remote-update-caused selection
  /// remaps count too (the caret genuinely moved in doc coordinates).
  private onViewSelectionSet(): void {
    if (!this.collabInstalled || this.isReadOnlyAttach()) return;
    if (this.cursorTimer !== null) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      if (!this.view || !this.collabInstalled || this.isReadOnlyAttach()) return;
      const sel = this.view.state.selection.main;
      this.send({ type: "cursor", anchor: sel.anchor, head: sel.head });
    }, DOC_CURSOR_THROTTLE_MS);
  }

  private clearCursorTimer(): void {
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }

  /// The attach algorithm, run against the shadow: on snapshot receipt
  /// and on view rebind. `pendingOverride` carries the hard-resync
  /// rebased changeset (C' = C.map(B)); when absent, pending is the
  /// content diff shadow -> view doc (degraded-window and pre-attach
  /// edits merge instead of clobbering).
  private tryAttach(pendingOverride?: ChangeSet | null): void {
    if (!this.view || !this.slot || !this.haveSnapshot) return;
    if (this.collabInstalled && pendingOverride === undefined) return;
    const view = this.view;
    const D = view.state.doc.toString();
    if (!this.collabInstalled && D !== lf(this.tab.content)) {
      // Editor doc has not caught up to the buffer yet (mounted mid
      // load); attach on the fill's update instead of pushing a bogus
      // whole-doc delete at the authority.
      this.attachQueued = true;
      return;
    }
    this.attachQueued = false;
    const S = this.shadowText.toString();

    let pending: ChangeSet | { from: number; to: number; insert: string }[] | null =
      null;
    if (D !== S) {
      if (pendingOverride !== undefined) {
        pending =
          pendingOverride !== null && !pendingOverride.empty
            ? pendingOverride
            : null;
      } else {
        pending = presentableDiff(S, D).map((c) => ({
          from: c.fromA,
          to: c.toA,
          insert: D.slice(c.fromB, c.toB),
        }));
        if (pending.length === 0) pending = null;
      }
    }

    // (1) cycle the slot empty so the whole-doc replace below is not a
    // collab-tracked local update and the fresh collab instance reseeds
    // its version field.
    if (this.collabInstalled) {
      view.dispatch({ effects: this.slot.reconfigure([]) });
      this.collabInstalled = false;
    }
    // (2) whole-doc replace D -> S, out of undo history, selection
    // clamped (the applyExternal shape).
    if (D !== S) {
      const prev = view.state.selection.main;
      const lim = S.length;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: S },
        selection: {
          anchor: Math.min(prev.anchor, lim),
          head: Math.min(prev.head, lim),
        },
        annotations: Transaction.addToHistory.of(false),
      });
    }
    // (3) install collab at the confirmed version with a FRESH clientID
    // per attachment: never per-SPA (split panes on one path would
    // mis-confirm each other's updates) and never window_id (same).
    view.dispatch({
      effects: this.slot.reconfigure(
        collab({ startVersion: this.shadowVersion, clientID: freshClientId() }),
      ),
    });
    this.collabInstalled = true;
    // (4) re-dispatch pending as normal edits: they become unconfirmed
    // local updates and push through the pump.
    if (pending !== null) {
      view.dispatch({ changes: pending });
    }
    this.promoteIfChannelUp();
    this.maybePush();
  }

  /// Promote to `attached` whenever the shadow is synced and the
  /// channel is genuinely up. Deliberately not keyed on the CURRENT
  /// status: a degraded session whose background retry lands a
  /// snapshot must heal even if the editor binds later (otherwise the
  /// classic PUT path and the collab pump would run side by side).
  private promoteIfChannelUp(): void {
    if (this.retryStopped) return;
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.setStatus("attached");
  }

  // ---- pump ------------------------------------------------------------

  private isReadOnlyAttach(): boolean {
    return this.tab.readMode || !this.tab.fsWritable;
  }

  private maybePush(): void {
    if (!this.view || !this.collabInstalled) return;
    // Single-writer discipline: a degraded tab's saves belong to the
    // classic PUT path, so the pump must not keep pushing on a
    // still-open socket (the same edit traveling both channels is the
    // duplicated-text / stale-token-409 recipe). Healing back to
    // `attached` re-opens the pump.
    if (this.status === "degraded" || this.status === "off") return;
    if (this.pushInFlight || this.staleLatch !== null) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.isReadOnlyAttach()) return;
    const updates = sendableUpdates(this.view.state);
    if (updates.length === 0) return;
    this.pushInFlight = true;
    this.send({
      type: "push",
      version: getSyncedVersion(this.view.state),
      updates: updates.map((u) => ({
        clientID: u.clientID,
        changes: u.changes.toJSON(),
      })),
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

  private send(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // The close handler owns recovery.
    }
  }

  // ---- socket lifecycle --------------------------------------------------

  private dial(fresh = false): void {
    this.clearReconnectTimer();
    this.closeSocket();
    this.sawFrameOnSocket = false;
    const version = !fresh && this.haveSnapshot ? this.shadowVersion : undefined;
    let ws: WebSocket;
    try {
      ws = createSocket(docWsUrl(this.path, version));
    } catch {
      this.onSocketClosed();
      return;
    }
    this.ws = ws;
    this.attachTimer = setTimeout(() => {
      // No frame within the window: count the dial as failed. Flag the
      // close as self-inflicted first so the capability probe in
      // onSocketClosed does not read a slow dial (high RTT, stalled
      // proxy hop) as a server without doc sync.
      if (!this.sawFrameOnSocket) {
        this.attachDialTimedOut = true;
        this.closeSocket();
        this.onSocketClosed();
      }
    }, DOC_ATTACH_TIMEOUT_MS);
    ws.onopen = () => {
      // A resumed socket (collab installed, incremental catch-up) is
      // attached on open: the server may have nothing to send, so no
      // frame can be awaited. A fresh dial stays `connecting` until the
      // snapshot lands and the attach algorithm runs.
      if (this.collabInstalled) {
        this.onChannelUp();
        this.setStatus("attached");
        this.maybePush();
      }
    };
    ws.onmessage = (m) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(m.data as string) as ServerFrame;
      } catch {
        return;
      }
      if (!this.sawFrameOnSocket) {
        this.sawFrameOnSocket = true;
        serverSupportsDocSync = true;
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
    const dialTimedOut = this.attachDialTimedOut;
    this.attachDialTimedOut = false;
    this.ws = null;
    this.clearPushInFlight();
    this.staleLatch = null;
    if (this.closedByUs || this.retryStopped) return;
    // Capability probe: the first doc-ws connect the SERVER closes
    // before any frame means an old server; latch module-wide and go
    // quiet. A close this client inflicted on itself (the attach
    // timeout above) proves nothing about capability and must retry
    // instead of latching doc sync off for the whole page load.
    if (serverSupportsDocSync === null && !this.sawFrameOnSocket && !dialTimedOut) {
      serverSupportsDocSync = false;
    }
    if (serverSupportsDocSync === false) {
      this.setStatus("off");
      this.retryStopped = true;
      return;
    }
    if (this.droppedAt === 0) this.droppedAt = Date.now();
    this.reconnectAttempts += 1;
    const inGrace =
      this.reconnectAttempts <= DOC_RECONNECT_GRACE_ATTEMPTS &&
      Date.now() - this.droppedAt < DOC_RECONNECT_GRACE_MS;
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

  /// Live-channel desync recovery: drop the socket and redial WITHOUT a
  /// version so the server answers with a fresh snapshot; the snapshot
  /// path rebases unconfirmed local edits by diff.
  private hardResync(): void {
    if (this.status === "attached") this.setStatus("reconnecting");
    this.closeSocket();
    this.dial(true);
  }

  private closeSocket(): void {
    const w = this.ws;
    this.ws = null;
    if (!w) return;
    // Defuse before close so a queued onclose can't fire after a newer
    // socket already took over (the openWatch reconnect race).
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
    // Sync-progress frames restart the save funnel's quiet window;
    // presence traffic (cursor frames) deliberately does not, so a
    // session that only relays peer cursors cannot pin a save open past
    // the quiet window.
    if (
      f.type === "snapshot" ||
      f.type === "updates" ||
      f.type === "push-ok" ||
      f.type === "push-stale" ||
      f.type === "flush"
    ) {
      this.noteFlushProgress();
    }
    switch (f.type) {
      case "snapshot":
        this.onSnapshot(f);
        return;
      case "updates":
        this.onUpdates(f);
        return;
      case "push-ok":
        this.tab.authorityVersion = f.version;
        this.clearPushInFlight();
        this.maybePush();
        this.checkFlushWaiters();
        return;
      case "push-stale":
        this.clearPushInFlight();
        if (this.shadowVersion >= f.version) {
          this.maybePush();
        } else {
          // The missed broadcasts are already in flight on this socket;
          // hold the next push until they land.
          this.staleLatch = f.version;
        }
        return;
      case "cursor":
        this.cursors.set(f.id, {
          w: f.w,
          anchor: f.anchor,
          head: f.head,
          version: f.version,
        });
        if (this.view) {
          const fx = cursorFrameEffects({
            id: f.id,
            w: f.w,
            anchor: f.anchor,
            head: f.head,
          });
          if (fx.length > 0) this.view.dispatch({ effects: fx });
        }
        this.mirror();
        return;
      case "cursor-gone":
        this.cursors.delete(f.id);
        if (this.view) {
          this.view.dispatch({ effects: removePeerEffect.of({ id: f.id }) });
        }
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
        console.warn("[chan] doc session error", this.path, f.reason, f.message);
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
    if (f.doc.indexOf("\r") !== -1) {
      // CodeMirror normalizes CR/CRLF on input, so client-side UTF-16
      // offsets would desync from the authority's exact text. Degrade to
      // the classic path (which has always LF-converted such files on
      // first save) rather than corrupt.
      console.warn("[chan] doc session: CRLF document, degrading", this.path);
      this.retryStopped = true;
      this.closeSocket();
      this.degrade();
      return;
    }
    // Hard resync (snapshot while attached): rebase unconfirmed local
    // updates by diff. B = diff(confirmedOld -> S), C = composed
    // sendable updates, C' = C.map(B); mapping failure drops the
    // unconfirmed edits with a notify (the editorBuffer hang-recovery
    // copy still holds them; nothing is silently lost).
    let pendingOverride: ChangeSet | null | undefined = undefined;
    if (this.view && this.collabInstalled) {
      pendingOverride = null;
      try {
        const sendable = sendableUpdates(this.view.state);
        if (sendable.length > 0) {
          let c = sendable[0]!.changes;
          for (let i = 1; i < sendable.length; i++) {
            c = c.compose(sendable[i]!.changes);
          }
          const oldS = this.shadowText.toString();
          const bSpec = presentableDiff(oldS, f.doc).map((ch) => ({
            from: ch.fromA,
            to: ch.toA,
            insert: f.doc.slice(ch.fromB, ch.toB),
          }));
          const b = ChangeSet.of(bSpec, oldS.length);
          pendingOverride = c.map(b);
        }
      } catch (e) {
        pendingOverride = null;
        console.warn("[chan] doc resync: rebase failed, dropping local edits", e);
        notify("Connection resync dropped unconfirmed edits (recovery copy kept)");
      }
    }
    this.shadowText = Text.of(f.doc.split("\n"));
    this.shadowVersion = f.version;
    this.tab.authorityVersion = f.version;
    this.haveSnapshot = true;
    // A snapshot opens a fresh sync epoch: any in-flight push belongs
    // to the pre-resync world and will never be answered on this epoch
    // (a reconnect already dropped it; a same-socket resync superseded
    // it). Clearing here lets the re-attach push immediately.
    this.clearPushInFlight();
    this.staleLatch = null;
    this.serverDirty = f.dirty;
    this.stampMtime(f.mtime_ns ?? null);
    this.cursors.clear();
    for (const c of f.cursors) {
      this.cursors.set(c.id, { w: c.w, anchor: c.anchor, head: c.head, version: c.version });
    }
    this.writeSaved();
    this.mirror();
    this.tryAttach(pendingOverride);
    if (this.view) {
      // Replace the presence field wholesale from the snapshot roster,
      // one dispatch, stale seeds (carets paint without flashing flags).
      const effects: StateEffect<unknown>[] = [clearPeersEffect.of(null)];
      for (const c of f.cursors) {
        effects.push(...cursorFrameEffects(c, { fresh: false }));
      }
      this.view.dispatch({ effects });
    }
    if (!this.view) {
      // Shadow-only session (editor between mounts): the snapshot is
      // fully absorbed; the next bindView attaches against it.
      this.promoteIfChannelUp();
    }
    this.checkFlushWaiters();
  }

  private onUpdates(f: Extract<ServerFrame, { type: "updates" }>): void {
    if (f.version !== this.shadowVersion) {
      // Frames are strict version order per socket; a gap means this
      // client is desynced. Resync loudly rather than guess.
      console.warn(
        "[chan] doc updates version gap",
        this.path,
        f.version,
        this.shadowVersion,
      );
      this.hardResync();
      return;
    }
    let parsed: { clientID: string; changes: ChangeSet }[];
    let text = this.shadowText;
    try {
      parsed = f.updates.map((u) => ({
        clientID: u.clientID,
        changes: ChangeSet.fromJSON(u.changes),
      }));
      for (const u of parsed) text = u.changes.apply(text);
    } catch (e) {
      console.warn("[chan] doc updates failed to apply, resyncing", e);
      this.hardResync();
      return;
    }
    this.shadowText = text;
    this.shadowVersion += parsed.length;
    this.tab.authorityVersion = this.shadowVersion;
    this.serverDirty = true;
    this.writeSaved();
    if (this.view && this.collabInstalled) {
      try {
        // The ONLY writer of remote changes into the view. Own-clientID
        // echoes confirm pending updates instead of re-applying, and the
        // transaction never enters local undo (pinned by test).
        this.view.dispatch(receiveUpdates(this.view.state, parsed));
      } catch (e) {
        console.warn("[chan] receiveUpdates failed, resyncing", e);
        this.hardResync();
        return;
      }
    }
    if (this.staleLatch !== null && this.shadowVersion >= this.staleLatch) {
      this.staleLatch = null;
      this.maybePush();
    }
    this.checkFlushWaiters();
  }

  private onFlush(f: Extract<ServerFrame, { type: "flush" }>): void {
    if (f.error !== undefined) {
      // Repeated flush failure server-side; the session stays alive
      // (data safe in memory and on every client). Surface it and let
      // any pending save fall back through the degrade path.
      this.tab.error = `save failed: ${f.error}`;
      this.settleFlushWaiters(false);
      return;
    }
    this.serverDirty = f.dirty;
    if (f.mtime_ns !== undefined) this.stampMtime(f.mtime_ns);
    this.checkFlushWaiters();
  }

  // ---- state mirroring -----------------------------------------------------

  /// Advance `tab.saved` to the confirmed shadow. Dirty then means
  /// "unconfirmed local edits" for every existing consumer.
  private writeSaved(): void {
    this.tab.saved = this.shadowText.toString();
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

  private allLocalConfirmed(): boolean {
    if (this.view && this.collabInstalled) {
      return !this.pushInFlight && sendableUpdates(this.view.state).length === 0;
    }
    // No bound editor: confirmed iff the buffer matches the shadow.
    return lf(this.tab.content) === this.shadowText.toString();
  }

  private checkFlushWaiters(): void {
    if (this.flushWaiters.length === 0) return;
    if (!this.ownsSaves()) {
      // Degraded/off mid-wait: resolve false so the save falls back to
      // the classic path instead of timing out.
      this.settleFlushWaiters(false);
      return;
    }
    if (this.status !== "attached") return;
    if (!this.allLocalConfirmed() || this.serverDirty) {
      this.maybePush();
      return;
    }
    this.settleFlushWaiters(true);
  }

  // ---- teardown --------------------------------------------------------

  /// Restamp peer name flags after a roster change (see
  /// `docSyncRosterChanged`).
  restampPeerNames(): void {
    if (!this.view) return;
    const fx = rosterRestampEffects(this.view.state);
    if (fx.length > 0) this.view.dispatch({ effects: fx });
  }

  private destroy(): void {
    this.closedByUs = true;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.clearReconnectTimer();
    this.clearAttachTimer();
    this.clearCursorTimer();
    this.settleFlushWaiters(false);
    this.clearPushInFlight();
    this.closeSocket();
    this.view = null;
    this.slot = null;
    this.collabInstalled = false;
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
}

// ---- registry --------------------------------------------------------------

/// Acquire (or re-acquire within the release linger) the doc session for
/// `tab`. Returns null when doc sync is off, unsupported, or the content
/// is over the size gate; the caller then simply has no session and the
/// classic paths run.
export function acquireDocSession(tab: FileTab): DocSession | null {
  if (!docSyncEnabled()) return null;
  // Size gate read untracked on purpose: eligibility must not re-run
  // the acquire effect per keystroke. Growth past the server's byte
  // limit mid-session is rejected loudly by the authority instead.
  if (tab.content.length > DOC_MAX_LEN) return null;
  const existing = registry.get(tab.id);
  if (existing) {
    if (existing.path === tab.path) {
      existing.retain();
      return existing;
    }
    existing.release({ immediate: true });
  }
  const session = new DocSession(tab);
  registry.set(tab.id, session);
  return session;
}

/// Release the session for `tabId`. Lingers by default (editor remount);
/// immediate for tab close, rename rekey, and file discard.
export function releaseDocSession(
  tabId: string,
  opts?: { immediate?: boolean },
): void {
  registry.get(tabId)?.release(opts);
}

export function docSessionFor(tabId: string): DocSession | undefined {
  return registry.get(tabId);
}

/// Roster hook: after a `session_roster` snapshot applies, re-resolve
/// every bound editor's peer name flags (a rename swaps flag text
/// without flashing it). Called by the /ws frame router.
export function docSyncRosterChanged(): void {
  for (const s of registry.values()) s.restampPeerNames();
}

/// Test seam: drop every session and reset the module-wide capability
/// latch. Never called in production.
export function resetDocSyncForTests(): void {
  for (const s of [...registry.values()]) s.release({ immediate: true });
  registry.clear();
  serverSupportsDocSync = null;
}

// ---- tabs.svelte.ts hooks ---------------------------------------------------
// Registered at module load (FileEditorTab imports this module with the
// app); the classic save path runs unhooked until then, which is correct
// because no session can exist before this module loads.

registerDocSaveDelegate(async (t: FileTab) => {
  const session = registry.get(t.id);
  if (!session || !session.ownsSaves()) return "classic";
  if (await session.flush()) return "saved";
  session.degrade();
  // Single-writer handoff: the degrade gated the pump; wait out any
  // push already on the wire before the classic PUT fires so the two
  // writers never interleave and the freshest flush token is on the
  // tab when the PUT stamps its CAS check.
  await session.awaitPushSettled();
  return "degraded";
});

registerDocReleaseHook((tabId: string, immediate: boolean) => {
  releaseDocSession(tabId, { immediate });
});

registerDocFallbackSavedHook((tabId: string) => {
  registry.get(tabId)?.healAfterFallbackSave();
});

registerDocSavePausedQuery((tabId: string) => {
  return registry.get(tabId)?.isOutagePaused() ?? false;
});
