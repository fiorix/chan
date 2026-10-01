// Remote peer cursors for co-edited documents.
//
// Presentation layer for the doc-session `cursor` frames: a StateField
// keyed by the server ATTACH id (not window_id - two panes of one window
// attach the same doc separately) renders every remote peer as a
// translucent selection plus a zero-width caret widget carrying the
// peer's name flag. docSync owns the socket and dispatches the effects
// below; this module never talks to the network and never imports
// docSync.
//
// Contract for the docSync pump (server frame -> dispatch):
//
//   cursor {id, w, anchor, head}  -> cursorFrameEffects(frame)
//   cursor-gone {id}              -> removePeerEffect.of({ id })
//   snapshot {cursors}            -> clearPeersEffect.of(null), plus
//                                    cursorFrameEffects(c, { fresh: false })
//                                    per seeded cursor (stale seeds paint
//                                    carets without flashing name flags)
//   session_roster applied        -> rosterRestampEffects(view.state),
//                                    dispatch when nonempty (silent
//                                    rename, no flag flash)
//
// One dispatch may batch any number of these effects. An editor remount
// starts from an empty field; docSync re-seeds presence from its own
// peer cache. Anchor/head are CM doc offsets (UTF-16 code units, the
// wire unit); out-of-range positions are clamped, never rejected - a
// cursor frame may race a concurrent edit by design (the server does
// not rebase cursors; clients map peers through their own transactions
// and the peer's next throttled frame corrects any residue).

import {
  type ChangeDesc,
  type EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { sessionWindowId } from "../../api/client";
import { sessionState } from "../../state/session.svelte";

/// Server attach id from the doc ws frames (`AtomicU64` on the server,
/// well under 2^53 in practice).
export type PeerId = number;

export interface PeerCursor {
  anchor: number;
  head: number;
  windowId: string;
  name: string;
  colorIdx: number;
  /// Epoch ms of the last live cursor frame; 0 for snapshot-seeded
  /// positions so a peer who is not actually moving never flashes a
  /// name flag on attach.
  lastMoveAt: number;
}

export type SetPeer = PeerCursor & { id: PeerId };

/// Upsert one peer. Positions are post-transaction offsets, like any CM
/// effect that carries positions; the map function keeps them valid if
/// the effect itself gets mapped through changes.
const setPeerEffect = StateEffect.define<SetPeer>({
  map: (v, changes) => ({ ...v, ...mapPeerRange(v.anchor, v.head, changes) }),
});

/// Drop one peer (the `cursor-gone` frame, or an attach that died).
export const removePeerEffect = StateEffect.define<{ id: PeerId }>();

/// Drop every peer (snapshot/hard-resync boundary, session teardown).
export const clearPeersEffect = StateEffect.define<null>();

const PEER_COLORS = 8;

/// How long a name flag counts as fresh after its peer's last live
/// cursor frame. Must cover the CSS fade (2s hold-then-fade in the
/// baseTheme below): rebuilds inside the window keep the widget DOM
/// (and its running animation) via eq; the first rebuild past it swaps
/// in the label-hidden DOM, which by then is visually identical.
const PEER_LABEL_FRESH_MS = 2000;

/// 32-bit FNV-1a. Color is derived from the stable window id, not the
/// per-attachment id, so a peer keeps one color across reconnects,
/// documents, and every pane that shows them.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function peerColorIdx(windowId: string): number {
  return fnv1a(windowId) % PEER_COLORS;
}

function clampPos(pos: number, docLen: number): number {
  return Math.max(0, Math.min(pos, docLen));
}

/// Resolve a window id to a display name through the session roster.
/// Exported: the scene collaborators layer (ExcalidrawCanvas) labels
/// canvas pointers with the same names the caret flags carry.
export function resolvePeerName(windowId: string): string {
  const row = sessionState.participants.find((p) => p.window_id === windowId);
  const name = row?.name?.trim();
  // The roster guarantees non-empty names for live participants, but a
  // cursor frame can beat the roster row (the doc attach races the /ws
  // seed); a window-id prefix keeps the flag identifying until the
  // roster restamp lands.
  return name || windowId.slice(0, 8);
}

/// Map a peer cursor through local changes. A caret maps with backward
/// association so local typing at the exact caret position leaves the
/// peer caret BEFORE the inserted text: if the peer is idle that is the
/// right place, and if the peer authored the insert their next cursor
/// frame corrects it within its ~100ms throttle. Selections shrink at
/// both boundaries (insertions at an edge stay outside the highlight,
/// the findField convention) and preserve anchor/head orientation; a
/// deletion spanning the whole range collapses it to a caret.
function mapPeerRange(
  anchor: number,
  head: number,
  changes: ChangeDesc,
): { anchor: number; head: number } {
  if (anchor === head) {
    const p = changes.mapPos(head, -1);
    return { anchor: p, head: p };
  }
  const low = changes.mapPos(Math.min(anchor, head), 1);
  const high = changes.mapPos(Math.max(anchor, head), -1);
  if (low >= high) {
    const p = changes.mapPos(head, -1);
    return { anchor: p, head: p };
  }
  return anchor < head ? { anchor: low, head: high } : { anchor: high, head: low };
}

class PeerCaretWidget extends WidgetType {
  constructor(
    readonly peer: PeerId,
    readonly name: string,
    readonly colorIdx: number,
    readonly fresh: boolean,
  ) {
    super();
  }

  eq(other: PeerCaretWidget): boolean {
    // Deliberately excludes position and timestamps: a caret that MOVED
    // gets a new DOM node anyway (new position), which restarts the
    // flag-fade animation, while rebuilds from unrelated transactions
    // keep the node, so 10Hz cursor traffic cannot churn the DOM.
    return (
      this.peer === other.peer &&
      this.name === other.name &&
      this.colorIdx === other.colorIdx &&
      this.fresh === other.fresh
    );
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = `cm-peer-caret cm-peer-c${this.colorIdx}`;
    // Presence chrome is decorative; the document text must read
    // uninterrupted to assistive tech.
    caret.setAttribute("aria-hidden", "true");
    if (this.fresh) caret.dataset.fresh = "true";
    const flag = document.createElement("span");
    flag.className = "cm-peer-flag";
    flag.textContent = this.name;
    caret.append(flag);
    return caret;
  }

  ignoreEvent(): boolean {
    // The caret is presentation only; clicks fall through so a user can
    // place their own cursor "through" a peer caret.
    return false;
  }
}

const peerSelMarks = Array.from({ length: PEER_COLORS }, (_, i) =>
  Decoration.mark({ class: `cm-peer-sel cm-peer-c${i}` }),
);

function colorSlot(idx: number): number {
  return ((idx % PEER_COLORS) + PEER_COLORS) % PEER_COLORS;
}

function buildPeerDecos(
  peers: Map<PeerId, PeerCursor>,
  docLen: number,
): DecorationSet {
  if (peers.size === 0) return Decoration.none;
  const now = Date.now();
  const ranges = [];
  for (const [id, p] of peers) {
    const idx = colorSlot(p.colorIdx);
    const from = clampPos(Math.min(p.anchor, p.head), docLen);
    const to = clampPos(Math.max(p.anchor, p.head), docLen);
    if (to > from) ranges.push(peerSelMarks[idx]!.range(from, to));
    const fresh = p.lastMoveAt > 0 && now - p.lastMoveAt < PEER_LABEL_FRESH_MS;
    ranges.push(
      Decoration.widget({
        widget: new PeerCaretWidget(id, p.name, idx, fresh),
        side: -1,
      }).range(clampPos(p.head, docLen)),
    );
  }
  return Decoration.set(ranges, true);
}

type ThemeSpec = Parameters<typeof EditorView.baseTheme>[0];

// Structural styles only; the eight peer colors come from the
// --peer-c0..7 vars (editor/themes/base.css), which are chosen deep
// enough that the fixed white flag text reads on them in both schemes.
// The fallback keeps carets visible if a host page lacks the palette.
function peerThemeSpec(): ThemeSpec {
  const spec: ThemeSpec = {
    ".cm-peer-caret": {
      position: "relative",
      display: "inline",
      borderLeft: "2px solid #888",
      marginLeft: "-1px",
      pointerEvents: "none",
    },
    ".cm-peer-flag": {
      position: "absolute",
      top: "-1.3em",
      left: "-2px",
      zIndex: "3",
      padding: "1px 5px",
      borderRadius: "4px 4px 4px 0",
      fontSize: "10px",
      fontWeight: "600",
      lineHeight: "1.4",
      whiteSpace: "nowrap",
      color: "#fff",
      opacity: "0",
      userSelect: "none",
    },
    // The fade restarts with each new widget DOM node (i.e. each real
    // cursor move); keep its total duration aligned with
    // PEER_LABEL_FRESH_MS.
    '.cm-peer-caret[data-fresh="true"] .cm-peer-flag': {
      animation: "cm-peer-flag-fade 2s forwards",
    },
    "@keyframes cm-peer-flag-fade": {
      "0%": { opacity: 1 },
      "80%": { opacity: 1 },
      "100%": { opacity: 0 },
    },
  };
  for (let i = 0; i < PEER_COLORS; i++) {
    const color = `var(--peer-c${i}, #888)`;
    spec[`.cm-peer-sel.cm-peer-c${i}`] = {
      backgroundColor: `color-mix(in srgb, ${color} 22%, transparent)`,
    };
    spec[`.cm-peer-caret.cm-peer-c${i}`] = { borderLeftColor: color };
    spec[`.cm-peer-caret.cm-peer-c${i} > .cm-peer-flag`] = {
      backgroundColor: color,
    };
  }
  return spec;
}

const peerBaseTheme = EditorView.baseTheme(peerThemeSpec());

type RemoteCursorsState = {
  peers: Map<PeerId, PeerCursor>;
  decos: DecorationSet;
};

const NO_PEERS: ReadonlyMap<PeerId, PeerCursor> = new Map();

export const remoteCursorsField = StateField.define<RemoteCursorsState>({
  create(): RemoteCursorsState {
    return { peers: new Map(), decos: Decoration.none };
  },
  update(prev, tr): RemoteCursorsState {
    let peers = prev.peers;
    if (tr.docChanged && peers.size > 0) {
      const mapped = new Map<PeerId, PeerCursor>();
      for (const [id, p] of peers) {
        mapped.set(id, { ...p, ...mapPeerRange(p.anchor, p.head, tr.changes) });
      }
      peers = mapped;
    }
    for (const e of tr.effects) {
      if (e.is(setPeerEffect)) {
        if (peers === prev.peers) peers = new Map(peers);
        const { id, ...cur } = e.value;
        const lim = tr.state.doc.length;
        peers.set(id, {
          ...cur,
          anchor: clampPos(cur.anchor, lim),
          head: clampPos(cur.head, lim),
        });
      } else if (e.is(removePeerEffect)) {
        if (!peers.has(e.value.id)) continue;
        if (peers === prev.peers) peers = new Map(peers);
        peers.delete(e.value.id);
      } else if (e.is(clearPeersEffect)) {
        if (peers.size === 0) continue;
        peers = new Map();
      }
    }
    if (peers === prev.peers) return prev;
    return { peers, decos: buildPeerDecos(peers, tr.state.doc.length) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.decos),
    peerBaseTheme,
  ],
});

/// One inbound `cursor` frame (or one `snapshot.cursors` entry, with
/// `fresh: false`) as dispatchable effects. Frames from any attach of
/// THIS window - including another split pane on the same document -
/// resolve to no effects: your own caret is not a peer.
export function cursorFrameEffects(
  frame: { id: PeerId; w: string; anchor: number; head: number },
  opts?: { fresh?: boolean },
): StateEffect<SetPeer>[] {
  if (frame.w === sessionWindowId()) return [];
  return [
    setPeerEffect.of({
      id: frame.id,
      anchor: frame.anchor,
      head: frame.head,
      windowId: frame.w,
      name: resolvePeerName(frame.w),
      colorIdx: peerColorIdx(frame.w),
      lastMoveAt: opts?.fresh === false ? 0 : Date.now(),
    }),
  ];
}

/// Re-resolve every held peer's name against the current roster; one
/// setPeer effect per changed name, positions and freshness untouched
/// (a rename swaps the flag text without flashing it). Dispatch after
/// applying a `session_roster` snapshot.
export function rosterRestampEffects(
  state: EditorState,
): StateEffect<SetPeer>[] {
  const f = state.field(remoteCursorsField, false);
  if (!f) return [];
  const out: StateEffect<SetPeer>[] = [];
  for (const [id, p] of f.peers) {
    const name = resolvePeerName(p.windowId);
    if (name !== p.name) out.push(setPeerEffect.of({ ...p, id, name }));
  }
  return out;
}

/// Read-only view of the held peers, mainly for tests and debugging;
/// docSync keeps its own peer-count cache for the tab badge.
export function peersIn(state: EditorState): ReadonlyMap<PeerId, PeerCursor> {
  return state.field(remoteCursorsField, false)?.peers ?? NO_PEERS;
}
