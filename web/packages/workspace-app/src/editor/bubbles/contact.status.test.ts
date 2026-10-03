// @vitest-environment jsdom
//
// What the contact bubble says under its rows: loading while its lookup is
// out, that the workspace has none once it answers empty, and the failure,
// with no rows left from an earlier query, when a lookup fails.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Contact = { path: string; label: string };

const lookups = vi.hoisted(() => ({
  contacts: [] as Contact[] | Promise<Contact[]>,
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      contacts: vi.fn(async () => lookups.contacts),
      mentions: vi.fn(async () => []),
    },
  };
});

import { api } from "../../api/client";
import { openContactBubble } from "./contact";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];
const handles: Array<{ dismiss(): void }> = [];

beforeEach(() => {
  lookups.contacts = [{ path: "Contacts/amy.md", label: "Amy Adams" }];
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dismiss();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

/// Open the bubble over `typed` (the whole doc) and wait out its lookup.
async function openOn(typed: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: typed, selection: { anchor: typed.length } }),
    parent,
  });
  views.push(view);
  const handle = openContactBubble({
    view,
    triggerStart: 0,
    triggerEnd: typed.length,
    initialQuery: typed.replace(/^@+/, ""),
    onDismiss: () => {},
    mode: "mention",
  });
  handles.push(handle);
  await new Promise((r) => setTimeout(r, 80));
  return { view, handle };
}

function rows(): string[] {
  return [...document.querySelectorAll(".md-contact-bubble .md-bubble-row")].map(
    (row) => row.firstElementChild?.textContent ?? "",
  );
}

function status(): string {
  return document.querySelector(".md-contact-bubble .md-bubble-status")?.textContent ?? "";
}

describe("the contact bubble's status", () => {
  test("says it is loading while the lookup is out", async () => {
    lookups.contacts = new Promise<Contact[]>(() => {});
    await openOn("@@");
    expect(status()).toBe("Loading contacts...");
  });

  test("says there are no contacts once the lookup answers empty", async () => {
    lookups.contacts = [];
    await openOn("@@");
    expect(status()).toBe("No contacts");
  });

  test("a lookup that fails takes the earlier rows off the list and says so", async () => {
    const { handle } = await openOn("@@am");
    expect(rows()).toEqual(["Amy Adams"]);
    vi.mocked(api.contacts).mockRejectedValueOnce(new Error("offline"));
    handle.setQuery("amy");
    await vi.waitFor(() => expect(status()).toBe("Contact lookup failed: offline"));
    expect(rows()).toEqual([]);
  });
});
