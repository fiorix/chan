// @vitest-environment jsdom
//
// The contact bubble offers the mention corpus beside contact files. It is
// opened on a real editor view over the typed trigger, with the contacts and
// mentions lookups stubbed; the assertions read the rows it renders, the
// lookups it makes and what a pick inserts. api.mentions itself is driven
// against a stubbed fetch.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Contact = { path: string; label: string; emails?: string[]; aliases?: string[] };

const lookups = vi.hoisted(() => ({
  contacts: [] as Contact[] | Promise<Contact[]>,
  mentions: [] as Array<{ label: string }>,
  mentionsFail: false,
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      contacts: vi.fn(async () => lookups.contacts),
      mentions: vi.fn(async () => {
        if (lookups.mentionsFail) throw new Error("no mentions route");
        return lookups.mentions;
      }),
    },
  };
});

import { api } from "../../api/client";
import { openContactBubble, type ContactBubbleMode } from "./contact";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];
const handles: Array<{ dismiss(): void }> = [];

const AMY: Contact = { path: "Contacts/amy.md", label: "Amy Adams", aliases: ["AA"] };

beforeEach(() => {
  lookups.contacts = [AMY];
  lookups.mentions = [{ label: "@@amy" }, { label: "@@aa" }, { label: "@@ambrose" }];
  lookups.mentionsFail = false;
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dismiss();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/// Open the bubble over `typed` (the whole doc) and wait out its lookup.
async function openOn(typed: string, mode: ContactBubbleMode) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: typed, selection: { anchor: typed.length } }),
    parent,
  });
  views.push(view);
  const onDismiss = vi.fn();
  const handle = openContactBubble({
    view,
    triggerStart: 0,
    triggerEnd: typed.length,
    initialQuery: typed.replace(/^@+/, ""),
    onDismiss,
    mode,
  });
  handles.push(handle);
  await new Promise((r) => setTimeout(r, 80));
  return { view, handle, onDismiss };
}

function rows(): Array<[string, "contact" | "mention"]> {
  return [...document.querySelectorAll(".md-contact-bubble .md-bubble-row")].map((row) => [
    row.firstElementChild?.textContent ?? "",
    row.classList.contains("md-bubble-row-mention-only") ? "mention" : "contact",
  ]);
}

function key(name: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name });
}

describe("the rows", () => {
  test("list contacts, then the mention tokens no contact already names, the latter marked", async () => {
    await openOn("@@am", "mention");
    expect(rows(), "@@amy is the contact's file name and @@aa its alias").toEqual([
      ["Amy Adams", "contact"],
      ["@@ambrose", "mention"],
    ]);
  });

  test("come from both lookups, under either trigger", async () => {
    for (const [typed, mode] of [
      ["@am", "wiki"],
      ["@@am", "mention"],
    ] as const) {
      vi.clearAllMocks();
      await openOn(typed, mode);
      expect(api.contacts).toHaveBeenCalledWith("am", 8);
      expect(api.mentions, mode).toHaveBeenCalledWith("am", 8);
    }
  });

  test("ask for the mentions without waiting on the contacts", async () => {
    lookups.contacts = new Promise<Contact[]>(() => {});
    await openOn("@@am", "mention");
    expect(api.mentions).toHaveBeenCalledTimes(1);
  });

  test("still list the contacts when the mentions lookup fails", async () => {
    lookups.mentionsFail = true;
    await openOn("@@am", "mention");
    expect(rows()).toEqual([["Amy Adams", "contact"]]);
  });
});

describe("a pick", () => {
  test("of a mention row inserts its token as listed, under either trigger", async () => {
    for (const [typed, mode] of [
      ["@am", "wiki"],
      ["@@am", "mention"],
    ] as const) {
      const { view, handle, onDismiss } = await openOn(typed, mode);
      handle.handleKey(key("ArrowDown"));
      expect(handle.handleKey(key("Enter"))).toBe(true);
      expect(view.state.doc.toString(), mode).toBe("@@ambrose");
      expect(onDismiss).toHaveBeenCalledTimes(1);
    }
  });

  test("of a contact row inserts a wiki link, or a mention under the @@ trigger", async () => {
    const wiki = await openOn("@am", "wiki");
    wiki.handle.handleKey(key("Enter"));
    expect(wiki.view.state.doc.toString()).toBe("[[Contacts/amy.md|Amy Adams]]");

    const mention = await openOn("@@am", "mention");
    mention.handle.handleKey(key("Enter"));
    expect(mention.view.state.doc.toString()).toBe("@@amy");
  });
});

describe("api.mentions", () => {
  test("asks /api/mentions for the prefix and the page size", async () => {
    const { api: real } = await vi.importActual<typeof import("../../api/client")>("../../api/client");
    const fetchMock = vi.fn(
      async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await real.mentions("am", 8);
    await real.mentions();
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls[0]).toMatch(/\/api\/mentions\?q=am&limit=8$/);
    expect(urls[1]).toMatch(/\/api\/mentions\?limit=10$/);
  });
});
