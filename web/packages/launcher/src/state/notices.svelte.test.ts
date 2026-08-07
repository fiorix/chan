// The notices ring: push/replace/evict semantics, the expand pointer, dismiss,
// and the local-error builder the reportError shim feeds.

import { describe, expect, test, beforeEach } from "vitest";
import {
  notices,
  pushNotice,
  pushLocalError,
  dismissNotice,
  toggleExpanded,
  clearNotices,
  type Notice,
} from "./notices.svelte";

function notice(id: string, over: Partial<Notice> = {}): Notice {
  return {
    id,
    kind: "info",
    source: { type: "gateway", id: "gw-1a2b3c4d", label: "gw.chan.app" },
    title: "title",
    message: "message",
    at: 1,
    ...over,
  };
}

beforeEach(() => {
  clearNotices();
});

describe("notices ring", () => {
  test("pushes append; a re-push of a live id replaces in place", () => {
    pushNotice(notice("ntc-1"));
    pushNotice(notice("ntc-2"));
    pushNotice(notice("ntc-1", { message: "updated" }));
    expect(notices.items.map((n) => n.id)).toEqual(["ntc-1", "ntc-2"]);
    expect(notices.items[0].message).toBe("updated");
  });

  test("the ring evicts the oldest past the bound and drops its expansion", () => {
    for (let i = 1; i <= 4; i++) pushNotice(notice(`ntc-${i}`));
    toggleExpanded("ntc-1");
    pushNotice(notice("ntc-5"));
    expect(notices.items.map((n) => n.id)).toEqual(["ntc-2", "ntc-3", "ntc-4", "ntc-5"]);
    expect(notices.expandedId).toBeNull();
  });

  test("dismiss removes the notice and its expansion", () => {
    pushNotice(notice("ntc-1"));
    toggleExpanded("ntc-1");
    dismissNotice("ntc-1");
    expect(notices.items).toEqual([]);
    expect(notices.expandedId).toBeNull();
  });

  test("expand toggles per id", () => {
    pushNotice(notice("ntc-1"));
    toggleExpanded("ntc-1");
    expect(notices.expandedId).toBe("ntc-1");
    toggleExpanded("ntc-1");
    expect(notices.expandedId).toBeNull();
  });

  test("local errors are desktop-sourced with an empty label and unique ids", () => {
    pushLocalError("first");
    pushLocalError("second");
    expect(notices.items).toHaveLength(2);
    const [a, b] = notices.items;
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe("error");
    expect(a.source).toEqual({ type: "desktop", id: "", label: "" });
    expect(a.message).toBe("first");
  });
});
