// Contact picker bubble.
//
// Two trigger shapes, one bubble:
//   - `@word`   (mode "wiki", legacy): commits `[[<path>|<label>]]`
//     so the picked contact lands as a wiki-link pill in the source.
//   - `@@word`  (mode "mention"): commits `@@<alias-or-stem>`
//     so the picked contact lands as a mention pill that
//     chan-server's mention_to_contact map resolves back to the
//     contact file via aliases + basename stem.
//
// Source: api.contacts(query, limit) - debounced 60ms per keystroke.
// req-seq pattern drops stale fetches if a newer query starts before
// the older response arrives.

import type { EditorView } from "@codemirror/view";
import { openBubbleShell } from "../bubble";
import { createCaretAnchor } from "./anchor";
import type { BubbleHandle } from "./types";
import { api } from "../../api/client";

export type ContactBubbleMode = "wiki" | "mention";

export interface ContactBubbleOpts {
  view: EditorView;
  triggerStart: number;
  triggerEnd: number;
  initialQuery: string;
  onDismiss: () => void;
  /// Insertion mode. "wiki" is the legacy `@` trigger; "mention" is
  /// the new `@@` trigger that writes `@@<alias-or-stem>` so the
  /// graph keeps the mention sigil in the source.
  mode?: ContactBubbleMode;
}

const PAGE_LIMIT = 8;
const FETCH_DEBOUNCE_MS = 60;

interface Contact {
  path: string;
  label: string;
  emails?: string[];
  aliases?: string[];
}

/// Mention-only hit. Represents a `@@<Name>` token observed in
/// the body text of indexed markdown that has no corresponding
/// contact file. Surfaces in the bubble below the contact-file
/// rows so the user can still complete to it.
interface MentionHit {
  /// Label WITH the `@@` sigil (the server-side route composes
  /// it). The commit path inserts this verbatim into the
  /// editor.
  label: string;
}

type Suggestion =
  | { kind: "contact"; contact: Contact }
  | { kind: "mention"; mention: MentionHit };

interface ContactBubbleHandle extends BubbleHandle {
  setTriggerEnd(end: number): void;
}

export function openContactBubble(opts: ContactBubbleOpts): ContactBubbleHandle {
  const caretPos = (): number => opts.view.state.selection.main.head;
  const anchor = createCaretAnchor(opts.view, caretPos());
  const shell = openBubbleShell({
    host: anchor.el,
    className: "md-contact-bubble cm-bubble",
  });
  let query = opts.initialQuery;
  let triggerEnd = opts.triggerEnd;
  let hits: Suggestion[] = [];
  let selectedIndex = 0;
  let reqSeq = 0;
  let debounceTimer: number | undefined;
  let alive = true;
  /// Mention-corpus completion is surfaced under BOTH triggers.
  /// Both modes merge contact-file hits first, then mention-only
  /// tokens from `api.mentions`. The insertion shape follows the
  /// picked row's kind, not the trigger: a contact-file hit
  /// commits a wiki-link under `@` (`commit`), a mention-only
  /// hit commits `@@<Name>` under either trigger
  /// (`commitMention`).
  const includeMentions = true;

  const list = document.createElement("div");
  list.className = "md-bubble-list";
  shell.wrap.appendChild(list);
  const status = document.createElement("div");
  status.className = "md-bubble-status";
  shell.wrap.appendChild(status);

  function fetchContacts(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    const seq = ++reqSeq;
    debounceTimer = window.setTimeout(() => {
      // Fan-out contacts + mentions in parallel. Both routes share
      // `PAGE_LIMIT` so the combined result is capped at
      // 2*PAGE_LIMIT before the dedup pass; the dedup typically
      // collapses common-name overlap back under PAGE_LIMIT.
      const contactsP = api.contacts(query, PAGE_LIMIT);
      const mentionsP = includeMentions
        ? api.mentions(query, PAGE_LIMIT).catch(() => [] as MentionHit[])
        : Promise.resolve<MentionHit[]>([]);
      Promise.all([contactsP, mentionsP])
        .then(([contactRows, mentionRows]) => {
          if (!alive || seq !== reqSeq) return;
          hits = mergeSuggestions(contactRows, mentionRows);
          if (selectedIndex >= hits.length) selectedIndex = 0;
          render();
        })
        .catch((err) => {
          if (!alive || seq !== reqSeq) return;
          hits = [];
          status.textContent = `Contact lookup failed: ${err.message ?? err}`;
        });
    }, FETCH_DEBOUNCE_MS);
  }

  /// Merge contact-file hits + mention-only tokens. Contact files
  /// come first (richer context: emails, aliases). Mention-only
  /// tokens come below and are filtered against the contact-file
  /// set and their aliases so the dropdown doesn't show the same
  /// name twice.
  ///
  /// Dedup key: lowercased name with the `@@` sigil stripped.
  /// A contact file with alias `@@alex` and the corpus's `@@Alex`
  /// collapse to one row (the contact-file row).
  function mergeSuggestions(
    contactRows: Contact[],
    mentionRows: MentionHit[],
  ): Suggestion[] {
    const out: Suggestion[] = contactRows.map((c) => ({
      kind: "contact",
      contact: c,
    }));
    if (!includeMentions || mentionRows.length === 0) return out;
    // Build the dedup set from each contact's basename stem +
    // their alias list (both lowercased, sans `@@`).
    const seen = new Set<string>();
    for (const c of contactRows) {
      seen.add(basenameStem(c.path));
      if (c.aliases) {
        for (const a of c.aliases) seen.add(a.toLowerCase());
      }
    }
    for (const m of mentionRows) {
      const bare = m.label.replace(/^@@/, "").toLowerCase();
      if (seen.has(bare)) continue;
      seen.add(bare);
      out.push({ kind: "mention", mention: m });
      if (out.length >= PAGE_LIMIT) break;
    }
    return out;
  }

  function render(): void {
    list.innerHTML = "";
    if (hits.length === 0) {
      status.textContent = query.length === 0
        ? "Loading contacts..."
        : "No matches";
      shell.reposition();
      return;
    }
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"} - ↵ to insert`;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      const row = document.createElement("div");
      row.className = "md-bubble-row";
      if (i === selectedIndex) row.classList.add("md-bubble-row-selected");
      if (hit.kind === "mention") {
        // Mention-only rows are dimmer than contact-file rows so
        // the user can tell this name has no contact file backing
        // it (body-text-only reference).
        row.classList.add("md-bubble-row-mention-only");
      }
      const label = document.createElement("div");
      label.textContent = hit.kind === "contact"
        ? hit.contact.label
        : hit.mention.label;
      row.appendChild(label);
      if (hit.kind === "contact") {
        const c = hit.contact;
        if (c.emails && c.emails.length > 0) {
          const sub = document.createElement("div");
          sub.className = "md-bubble-row-sub";
          sub.textContent = c.emails[0]!;
          row.appendChild(sub);
        }
        // Aliases ride as a tertiary line so power users see at a
        // glance which @@<alias> shortcuts resolve to this contact.
        // Suppressed when empty so the common (no-alias) case keeps
        // the row compact.
        if (c.aliases && c.aliases.length > 0) {
          const aliasLine = document.createElement("div");
          aliasLine.className = "md-bubble-row-sub md-bubble-row-aliases";
          aliasLine.textContent = c.aliases.map((a) => `@@${a}`).join(" - ");
          row.appendChild(aliasLine);
        }
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (hit.kind === "contact") commit(hit.contact);
        else commitMention(hit.mention);
      });
      list.appendChild(row);
    }
    shell.reposition();
  }

  /// Mention-only commit. The `@@Name` token arrives with its
  /// sigil already attached (the server-side route composes it),
  /// so the insert path is a straight substitution. Distinct from
  /// `commit(contact)` because there is no path / alias resolution
  /// to do.
  function commitMention(m: MentionHit): void {
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert: m.label },
      selection: { anchor: opts.triggerStart + m.label.length },
    });
    dismiss();
  }

  function commit(c: Contact): void {
    // Two insertion shapes (see module docstring):
    //   - wiki mode (the legacy `@` trigger): `[[<path>|<label>]]`.
    //     The wikilink atom widget renders the pill on the next
    //     decoration tick.
    //   - mention mode (the `@@` trigger): `@@<alias-or-stem>`. The
    //     mention extractor + mention_to_contact map resolve this
    //     back to the contact file at graph query time.
    //
    // For mention mode we prefer the user's typed query when it
    // exactly matches one of the contact's aliases (or the basename
    // stem); otherwise fall back to the basename stem. That keeps
    // the user's intent ("they typed `@@ali`") visible in the
    // source rather than blindly rewriting to a canonical form.
    const mode: ContactBubbleMode = opts.mode ?? "wiki";
    const insert = mode === "mention"
      ? `@@${pickMentionName(c, query)}`
      : `[[${c.path}|${c.label}]]`;
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert },
      selection: { anchor: opts.triggerStart + insert.length },
    });
    dismiss();
  }

  function pickMentionName(c: Contact, typed: string): string {
    const lower = typed.toLowerCase();
    const stem = basenameStem(c.path);
    if (lower === stem) return stem;
    if (c.aliases) {
      for (const a of c.aliases) {
        if (a.toLowerCase() === lower) return a;
      }
    }
    return stem;
  }

  function basenameStem(path: string): string {
    const slash = path.lastIndexOf("/");
    const base = slash < 0 ? path : path.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    return (dot <= 0 ? base : base.slice(0, dot)).toLowerCase();
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    shell.dismiss();
    anchor.dismiss();
    opts.onDismiss();
  }

  fetchContacts();
  render();

  return {
    handleKey(event) {
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (event.key === "Enter") {
        const hit = hits[selectedIndex];
        if (hit) {
          if (hit.kind === "contact") commit(hit.contact);
          else commitMention(hit.mention);
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
      fetchContacts();
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
