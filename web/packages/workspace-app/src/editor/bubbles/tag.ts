// Tag picker bubble for the `#word` trigger.
//
// Source of truth: api.graph() (cached on first open). Tag-kind nodes
// in the graph have id `#name`; we surface them as a flat list, filter
// in-memory by the typed query (case-insensitive substring), commit by
// replacing the `#query` trigger with `#chosen`.
//
// No network round-trip per keystroke (graph fetch is one-shot, then
// in-memory filter). Mirrors the legacy editor's tag picker behavior.

import type { EditorView } from "@codemirror/view";
import { openBubbleShell } from "../bubble";
import { createCaretAnchor } from "./anchor";
import type { BubbleHandle } from "./types";
import { api } from "../../api/client";

export interface TagBubbleOpts {
  view: EditorView;
  triggerStart: number;
  triggerEnd: number;
  initialQuery: string;
  onDismiss: () => void;
}

const RESULT_LIMIT = 5;

interface TagBubbleHandle extends BubbleHandle {
  setTriggerEnd(end: number): void;
}

// Tag list cache. Lives at module scope so multiple bubble opens
// across the session share the same fetch.
let tagsCache: string[] | null = null;
let tagsInflight: Promise<string[]> | null = null;

async function loadTags(): Promise<string[]> {
  if (tagsCache !== null) return tagsCache;
  if (tagsInflight) return tagsInflight;
  tagsInflight = api
    .graph()
    .then((g) => {
      const nodes = (g as { nodes?: Array<{ kind: string; id: string }> }).nodes ?? [];
      const tags = nodes
        .filter((n) => n.kind === "tag")
        .map((n) => (n.id.startsWith("#") ? n.id.slice(1) : n.id))
        .sort((a, b) => a.localeCompare(b));
      tagsCache = tags;
      return tags;
    })
    .finally(() => {
      tagsInflight = null;
    });
  return tagsInflight;
}

export function openTagBubble(opts: TagBubbleOpts): TagBubbleHandle {
  const caretPos = (): number => opts.view.state.selection.main.head;
  const anchor = createCaretAnchor(opts.view, caretPos());
  const shell = openBubbleShell({
    host: anchor.el,
    className: "md-tag-bubble cm-bubble",
  });
  let query = opts.initialQuery;
  let triggerEnd = opts.triggerEnd;
  let allTags: string[] = [];
  /// Whether the tag list has loaded: an empty list says "Loading" only
  /// before that, or a workspace with no tags would load for ever.
  let loaded = false;
  let hits: string[] = [];
  let selectedIndex = 0;
  let alive = true;

  const list = document.createElement("div");
  list.className = "md-bubble-list";
  shell.wrap.appendChild(list);
  const status = document.createElement("div");
  status.className = "md-bubble-status";
  shell.wrap.appendChild(status);

  function filter(): void {
    const q = query.toLowerCase();
    hits = q.length === 0
      ? allTags.slice(0, RESULT_LIMIT)
      : allTags.filter((t) => t.toLowerCase().includes(q)).slice(0, RESULT_LIMIT);
    if (selectedIndex >= hits.length) selectedIndex = 0;
    render();
  }

  function render(): void {
    list.innerHTML = "";
    if (hits.length === 0) {
      status.textContent = !loaded
        ? "Loading tags..."
        : allTags.length === 0
          ? "No tags"
          : "No matches";
      shell.reposition();
      return;
    }
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"} - ↵ to insert`;
    for (let i = 0; i < hits.length; i++) {
      const tag = hits[i]!;
      const row = document.createElement("div");
      row.className = "md-bubble-row";
      if (i === selectedIndex) row.classList.add("md-bubble-row-selected");
      row.textContent = `#${tag}`;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        commit(tag);
      });
      list.appendChild(row);
    }
    shell.reposition();
  }

  function commit(tag: string): void {
    const insert = `#${tag}`;
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert },
      selection: { anchor: opts.triggerStart + insert.length },
    });
    dismiss();
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    shell.dismiss();
    anchor.dismiss();
    opts.onDismiss();
  }

  loadTags()
    .then((tags) => {
      if (!alive) return;
      allTags = tags;
      loaded = true;
      filter();
    })
    .catch((err) => {
      if (!alive) return;
      status.textContent = `Tag list failed: ${err.message ?? err}`;
    });
  filter();

  return {
    handleKey(event) {
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (event.key === "Enter") {
        const tag = hits[selectedIndex];
        if (tag) {
          commit(tag);
          return true;
        }
        return false;
      }
      if (event.key === "ArrowDown") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex + 1) % hits.length;
        render();
        return true;
      }
      if (event.key === "ArrowUp") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex - 1 + hits.length) % hits.length;
        render();
        return true;
      }
      return false;
    },
    setQuery(q) {
      anchor.update(opts.view, caretPos());
      shell.reposition();
      if (q === query) return;
      query = q;
      filter();
    },
    setTriggerEnd(end) {
      triggerEnd = end;
    },
    reposition() {
      anchor.update(opts.view, caretPos());
      shell.reposition();
    },
    dismiss,
  };
}
