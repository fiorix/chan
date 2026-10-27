// Corner-card notices for the launcher: the desktop's `launcher-notice`
// events (gateway / devserver-sourced narration) and locally raised action
// errors share one bounded ring rendered by NoticeBubbles. Each notice
// carries its SOURCE; a bubble expands on click to the full message and
// carries a Dismiss.

export type NoticeKind = "error" | "info";
export type NoticeSourceType = "gateway" | "devserver" | "desktop";

export interface NoticeSource {
  type: NoticeSourceType;
  id: string;
  label: string;
}

/** The launcher-notice payload: the desktop's serde shape, mirrored exactly. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  source: NoticeSource;
  title: string;
  message: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** The ring bound: pushes past it evict the oldest bubble. */
const MAX_NOTICES = 4;

interface NoticesState {
  items: Notice[];
  /** The one expanded bubble (full message visible), or null. */
  expandedId: string | null;
  now: number;
}

export const notices = $state<NoticesState>({ items: [], expandedId: null, now: Date.now() });

let localSeq = 0;
let clock: ReturnType<typeof setInterval> | null = null;

function startClock(): void {
  notices.now = Date.now();
  if (clock !== null) return;
  clock = setInterval(() => {
    notices.now = Date.now();
  }, 30_000);
}

function stopClock(): void {
  if (clock === null) return;
  clearInterval(clock);
  clock = null;
}

/** Push a notice (a desktop launcher-notice payload or a locally built one).
 * A re-push of a live id replaces that notice in place; a fresh id appends
 * and the ring evicts from the oldest end. */
export function pushNotice(n: Notice): void {
  startClock();
  const i = notices.items.findIndex((x) => x.id === n.id);
  if (i >= 0) {
    notices.items[i] = n;
    return;
  }
  notices.items.push(n);
  if (notices.items.length > MAX_NOTICES) {
    const evicted = notices.items.splice(0, notices.items.length - MAX_NOTICES);
    if (evicted.some((x) => x.id === notices.expandedId)) notices.expandedId = null;
  }
}

/** A locally raised error (the reportError shim's target). The source label
 * stays empty: local failures have no gateway/devserver identity, and a
 * browser surface must not claim a desktop one. */
export function pushLocalError(message: string): void {
  localSeq += 1;
  pushNotice({
    id: `ntc-local-${localSeq}`,
    kind: "error",
    source: { type: "desktop", id: "", label: "" },
    title: "Error",
    message,
    at: Date.now(),
  });
}

export function dismissNotice(id: string): void {
  notices.items = notices.items.filter((n) => n.id !== id);
  if (notices.expandedId === id) notices.expandedId = null;
  if (notices.items.length === 0) stopClock();
}

export function toggleExpanded(id: string): void {
  notices.expandedId = notices.expandedId === id ? null : id;
}

export function clearNotices(): void {
  notices.items = [];
  notices.expandedId = null;
  stopClock();
}
