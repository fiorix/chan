/** A scope's id. Each host lists its own scopes, so the deck treats the id as
 * opaque and compares it only against the scopes it was given. */
export type DeckScopeId = string;

const SESSION_DECK_DRAFT_PREFIX = "chan.command-launcher.v1:";

/** The session-storage key a launcher surface keeps its deck draft under. The
 * `contextual` suffix is the key drafts already saved in open tabs use, so a
 * reload keeps them. */
export const SESSION_DECK_DRAFT_KEY = `${SESSION_DECK_DRAFT_PREFIX}contextual`;

// Svelte libraries publish icons as function components or class constructors.
// The opaque boundary accepts both through their shared size/stroke props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeckIcon = any;

export interface DeckConfirm {
  title: string;
  message: string;
  actionLabel: string;
  danger?: boolean;
}

export interface DeckItem {
  /** Stable within its command source and navigation path. */
  id: string;
  title: string;
  /** Trusted path rendered under the title, for example Tab > Terminal. */
  breadcrumb: string;
  searchText: string;
  scope: DeckScopeId;
  icon?: DeckIcon;
  shortcut?: string | null;
  /** How the row answers Enter: an action runs, a branch and a choice open a
   * deeper list, a toggle flips its state. Absent means action. */
  kind?: "action" | "branch" | "toggle" | "choice";
  /** The heading this row sits under while the deck browses. Consecutive rows
   * that share it form one section. A row without one renders flat with its
   * breadcrumb, as a typed result does. */
  section?: string;
  /** A second line under the title: an object's machine or path, or the
   * reason a disabled row cannot run. */
  subtitle?: string;
  /** Current state for the row's right column: on, off, or a choice's value. */
  value?: string;
  /** Marks the current option inside a choice. */
  checked?: boolean;
  /** A destructive action, drawn as one. */
  danger?: boolean;
  /** The row runs on Enter and also has a page of its own, which Right opens
   * through the deck's `onExpand`: a window that Enter focuses and whose
   * other actions sit one level down. */
  expandable?: boolean;
  disabled?: boolean;
  /** Keep the deck open while the returned promise settles. */
  awaitResult?: boolean;
  /**
   * Dismiss in the same microtask as a successful result instead of showing the
   * brief success card. Use for actions that move focus to another window: once
   * this document is backgrounded, browsers may throttle the success timer.
   */
  dismissImmediatelyOnSuccess?: boolean;
  /** Static confirmation metadata, or a lazy query that prepares it when the
   * command is chosen. */
  confirm?: DeckConfirm | (() => DeckConfirm | Promise<DeckConfirm>);
}

export interface DeckScope {
  id: DeckScopeId;
  label: string;
  /** A shorter name for the rail when the label is too long to sit under an
   * orb. Absent means the label. */
  caption?: string;
  icon: DeckIcon;
  available?: boolean;
}

export type DeckOperation =
  | {
      kind: "confirm";
      itemId: string;
      title: string;
      message: string;
      actionLabel: string;
      danger: boolean;
      selected: "cancel" | "action";
    }
  | { kind: "preparing"; itemId: string; title: string }
  | { kind: "pending"; itemId: string; title: string }
  | { kind: "success"; itemId: string; title: string }
  | { kind: "error"; itemId: string; title: string; message: string; selected: "back" | "retry" };

export interface DeckDraft {
  version: 1;
  visible: boolean;
  query: string;
  path: string[];
  selectedId: string | null;
  scope: DeckScopeId | null;
  operation: DeckOperation | null;
  contextChanged: boolean;
}

export function createDeckDraft(): DeckDraft {
  return {
    version: 1,
    visible: false,
    query: "",
    path: [],
    selectedId: null,
    scope: null,
    operation: null,
    contextChanged: false,
  };
}

/** A restored scope is any short id. Whether the host still offers it is the
 * host's and the deck's to settle against the live scope list. */
function isScope(value: unknown): value is DeckScopeId {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function boundedString(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function parseOperation(value: unknown): DeckOperation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const itemId = boundedString(raw.itemId, 512);
  const title = boundedString(raw.title, 256);
  if (!itemId || !title) return null;
  // Only confirmation and displayed-error cards have meaning after restore.
  // Promise-backed cards belong to the page and command source running them.
  if (raw.kind === "preparing" || raw.kind === "pending" || raw.kind === "success") return null;
  if (raw.kind === "confirm") {
    const message = boundedString(raw.message, 1024);
    const actionLabel = boundedString(raw.actionLabel, 128);
    if (!message || !actionLabel) return null;
    return {
      kind: "confirm",
      itemId,
      title,
      message,
      actionLabel,
      danger: raw.danger === true,
      selected: raw.selected === "action" ? "action" : "cancel",
    };
  }
  if (raw.kind === "error") {
    const message = boundedString(raw.message, 1024);
    if (!message) return null;
    return {
      kind: "error",
      itemId,
      title,
      message,
      selected: raw.selected === "retry" ? "retry" : "back",
    };
  }
  return null;
}

/** Restore bounded serializable draft fields from untrusted state. */
export function parseDeckDraft(value: unknown, fallback: DeckDraft): DeckDraft {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<DeckDraft>;
  return {
    version: 1,
    visible: raw.visible === true,
    query: typeof raw.query === "string" ? raw.query.slice(0, 2048) : fallback.query,
    path: Array.isArray(raw.path)
      ? raw.path
          .filter((part): part is string => typeof part === "string" && part.length <= 256)
          .slice(0, 16)
      : fallback.path,
    selectedId: boundedString(raw.selectedId, 512),
    scope: isScope(raw.scope) ? raw.scope : fallback.scope,
    operation: parseOperation(raw.operation),
    contextChanged: raw.contextChanged === true,
  };
}

export function loadSessionDeckDraft(key: string): DeckDraft {
  const fallback = createDeckDraft();
  if (typeof sessionStorage === "undefined") return fallback;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? parseDeckDraft(JSON.parse(raw), fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function saveSessionDeckDraft(key: string, draft: DeckDraft): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage denial degrades to an in-memory draft for this page lifetime.
  }
}

/**
 * Remove launcher drafts copied into a new browsing context by window.open.
 * Call this only for a freshly created blank window, before navigating it. The
 * opener keeps its draft and unrelated child session state remains available.
 */
export function clearClonedSessionDeckDrafts(target: Window | null): void {
  if (!target) return;
  try {
    const storage = target.sessionStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(SESSION_DECK_DRAFT_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Navigation remains available when storage access is denied.
  }
}

/** Prefix, substring, then compact subsequence ranking. null means no match. */
export function fuzzyDeckScore(query: string, text: string): number | null {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return 0;
  const target = text.toLocaleLowerCase();
  const at = target.indexOf(q);
  if (at === 0) return 10_000 - target.length;
  if (at > 0) return 7_000 - at * 8 - target.length;
  let cursor = 0;
  let previous = -2;
  let score = 3_000;
  for (const char of q) {
    const found = target.indexOf(char, cursor);
    if (found < 0) return null;
    score += found === previous + 1 ? 24 : 4;
    score -= found;
    previous = found;
    cursor = found + 1;
  }
  return score;
}

// One band per kind of hit. The position and length penalties inside a band
// stay under BAND_REACH, so a hit never sinks into the band below it, and the
// loosest hit, an abbreviation, sits under every band.
const TITLE_WORD_START = 40_000;
const TITLE_INSIDE_WORD = 30_000;
const OTHER_WORD_START = 20_000;
const OTHER_INSIDE_WORD = 10_000;
const BAND_REACH = 5_000;
// How far apart an abbreviation's letters may stand: within a stretch of the
// title this many times as long as the word.
const ABBREVIATION_REACH = 2;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Where `word` sits in `text`, both lowercased: at a word's start when any
 * occurrence is at one, else at its first occurrence. null means absent. */
function wordHit(word: string, text: string): { start: boolean; at: number } | null {
  let first = -1;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0 || !WORD_CHARACTER.test(text[at - 1] ?? "")) return { start: true, at };
    if (first < 0) first = at;
  }
  return first < 0 ? null : { start: false, at: first };
}

/** The tightest stretch of `title` that holds the letters of `word` in order,
 * by where it starts and how many characters it covers from the first letter
 * to the last, when one covers at most ABBREVIATION_REACH times the word's
 * length. `trmnl` is found in "terminal" this way and `clsw` in "close
 * window"; `nt` is not found in "new terminal", where n to t covers five
 * characters. A word of one character has no such form: a title that holds
 * its letter holds the word. */
function abbreviationHit(word: string, title: string): { at: number; span: number } | null {
  const reach = word.length * ABBREVIATION_REACH;
  const first = word.charAt(0);
  let best: { at: number; span: number } | null = null;
  for (let at = title.indexOf(first); at >= 0; at = title.indexOf(first, at + 1)) {
    // Taking each next letter at its first chance ends the stretch soonest.
    let end = at;
    for (let index = 1; index < word.length && end >= 0; index += 1) {
      end = title.indexOf(word.charAt(index), end + 1);
    }
    // A letter missing after this start is missing after every later one.
    if (end < 0) break;
    const span = end - at + 1;
    if (span <= reach && (best === null || span < best.span)) best = { at, span };
  }
  return best;
}

/** One query word against one row. The title is read first, so a word the
 * title holds never scores as a hit elsewhere. A word found whole nowhere
 * may still be an abbreviation of the title. The other fields are not read
 * that way: a path or a list of keywords is long enough to hold the letters
 * of most short words in order. */
function wordScore(word: string, title: string, others: readonly string[]): number | null {
  const inTitle = wordHit(word, title);
  if (inTitle) {
    const band = inTitle.start ? TITLE_WORD_START : TITLE_INSIDE_WORD;
    return band - Math.min(inTitle.at, 400) * 8 - Math.min(title.length, 400);
  }
  let best: number | null = null;
  for (const text of others) {
    const hit = wordHit(word, text);
    if (!hit) continue;
    const score = (hit.start ? OTHER_WORD_START : OTHER_INSIDE_WORD) - Math.min(hit.at, 400) * 8;
    if (best === null || score > best) best = score;
  }
  if (best !== null) return best;
  const loose = abbreviationHit(word, title);
  if (!loose) return null;
  return Math.max(1, BAND_REACH - 1 - loose.span * 8 - Math.min(loose.at, 400) * 2);
}

/**
 * Rows matching `query`, best first. The query is split on whitespace and
 * every word must match the row's title, breadcrumb, subtitle or search text,
 * in any order. A word in the title outranks one found elsewhere, and a word
 * that starts a word outranks one inside a word. A word found whole in none of
 * them still matches a title that holds its letters in order within twice the
 * word's length, below every whole hit. Rows that can run come before disabled
 * ones; ties fall to the title, then the id. An empty query returns the rows
 * as given.
 */
export function rankDeckItems(items: readonly DeckItem[], query: string): DeckItem[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  const ranked: { item: DeckItem; score: number }[] = [];
  for (const item of items) {
    const title = item.title.toLocaleLowerCase();
    const others = [item.breadcrumb, item.subtitle ?? "", item.searchText].map((text) =>
      text.toLocaleLowerCase(),
    );
    let score = 0;
    for (const word of words) {
      const hit = wordScore(word, title, others);
      if (hit === null) {
        score = -1;
        break;
      }
      score += hit;
    }
    if (score >= 0) ranked.push({ item, score });
  }
  return ranked
    .sort(
      (a, b) =>
        Number(a.item.disabled === true) - Number(b.item.disabled === true) ||
        b.score - a.score ||
        a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" }) ||
        a.item.id.localeCompare(b.item.id),
    )
    .map((row) => row.item);
}
