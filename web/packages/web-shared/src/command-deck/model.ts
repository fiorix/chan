export type DeckScopeId = "tab" | "pane" | "window" | "computers";
export type DeckEntryMode = "contextual" | "computers";

// Svelte libraries may publish icons as either Svelte 5 Components or the
// backwards-compatible class-shaped component type. The deck only invokes the
// shared size/stroke props; keeping this boundary opaque accepts both forms.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DeckIcon = any;

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
  kind?: "action" | "branch";
  disabled?: boolean;
  /** Keep the deck open while the returned promise settles. */
  awaitResult?: boolean;
  confirm?: {
    title: string;
    message: string;
    actionLabel: string;
    danger?: boolean;
  };
}

export interface DeckScope {
  id: DeckScopeId;
  label: string;
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

export function createDeckDraft(entryMode: DeckEntryMode = "contextual"): DeckDraft {
  return {
    version: 1,
    visible: false,
    query: "",
    path: [],
    selectedId: null,
    scope: entryMode === "computers" ? "computers" : null,
    operation: null,
    contextChanged: false,
  };
}

function isScope(value: unknown): value is DeckScopeId {
  return value === "tab" || value === "pane" || value === "window" || value === "computers";
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
  if (raw.kind === "pending" || raw.kind === "success") {
    return { kind: raw.kind, itemId, title };
  }
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

/** Parse untrusted persisted state. Runtime command callbacks never enter storage. */
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

export function loadSessionDeckDraft(key: string, entryMode: DeckEntryMode): DeckDraft {
  const fallback = createDeckDraft(entryMode);
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

export function rankDeckItems(items: readonly DeckItem[], query: string): DeckItem[] {
  const q = query.trim();
  if (!q) return [...items];
  return items
    .map((item) => ({
      item,
      score: fuzzyDeckScore(q, `${item.title} ${item.breadcrumb} ${item.searchText}`),
    }))
    .filter((row): row is { item: DeckItem; score: number } => row.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base" }) ||
        a.item.id.localeCompare(b.item.id),
    )
    .map((row) => row.item);
}
