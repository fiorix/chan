import { describe, expect, it } from "vitest";

import {
  FRAME_GRACE_MS,
  cascadePlacement,
  closeDecision,
  closesWindowOnCloseTab,
  createOpenShim,
  frameTitle,
  isCloseTabChord,
  isCycleChord,
  isNewWindowChord,
  loadGeometry,
  makeFakeWindow,
  newWindowRequest,
  nextFrameId,
  normalizeCollapse,
  normalizeDestination,
  reconcileFrames,
  saveGeometry,
  tenantLeader,
  toggleCollapse,
  watchBackoff,
  windowIdFromUrl,
  windowUrlFor,
} from "./hybrid-core.mjs";

const ORIGIN = "http://127.0.0.1:8642";

// A tiny document stand-in: selector -> matching element count.
const fakeDoc = (counts) => ({
  querySelector: (sel) => ((counts[sel] || 0) > 0 ? {} : null),
  querySelectorAll: (sel) => new Array(counts[sel] || 0).fill({}),
});

describe("windowUrlFor", () => {
  it("mirrors the launcher's windowUrl contract for a workspace", () => {
    const url = new URL(
      windowUrlFor(
        {
          window_id: "w-abc123",
          prefix: "/chan-7fa04f2c",
          kind: "workspace",
          library_id: "lib-2abda53aa392de73",
          token: "tok123",
        },
        ORIGIN,
      ),
    );
    expect(url.pathname).toBe("/chan-7fa04f2c/");
    expect(url.searchParams.get("w")).toBe("w-abc123");
    expect(url.searchParams.get("lib")).toBe("lib-2abda53aa392de73");
    expect(url.searchParams.get("t")).toBe("tok123");
    expect(url.searchParams.get("kind")).toBeNull();
  });

  it("stamps kind for terminals and omits an empty token", () => {
    const url = new URL(
      windowUrlFor({ window_id: "w-t", prefix: "api/terminal", kind: "terminal", token: "" }, ORIGIN),
    );
    expect(url.pathname).toBe("/api/terminal/");
    expect(url.searchParams.get("kind")).toBe("terminal");
    expect(url.searchParams.get("t")).toBeNull();
  });

  it("spells the control terminal's kind", () => {
    const url = new URL(
      windowUrlFor(
        { window_id: "w-c", prefix: "/api/terminal", kind: "terminal", control: true },
        ORIGIN,
      ),
    );
    expect(url.searchParams.get("kind")).toBe("control");
  });
});

describe("windowIdFromUrl", () => {
  it("reads ?w= for absolute and root-relative URLs", () => {
    expect(windowIdFromUrl("/p/?w=w-1&t=x", ORIGIN)).toBe("w-1");
    expect(windowIdFromUrl(`${ORIGIN}/p/index.html?w=w-2`, ORIGIN)).toBe("w-2");
  });

  it("answers null for a URL without one, and for an unparseable URL", () => {
    expect(windowIdFromUrl("/p/", ORIGIN)).toBeNull();
    expect(windowIdFromUrl("::::", undefined)).toBeNull();
  });
});

describe("chords", () => {
  const event = (code) => (over) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    code,
    ...over,
  });

  it("isNewWindowChord matches CmdOrCtrl+Shift+N only", () => {
    const e = event("KeyN");
    expect(isNewWindowChord(e({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isNewWindowChord(e({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isNewWindowChord(e({ ctrlKey: true }))).toBe(false);
    // Alt is excluded so AltGr combinations cannot alias into the chord.
    expect(isNewWindowChord(e({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isNewWindowChord(e({ ctrlKey: true, shiftKey: true, code: "KeyM" }))).toBe(false);
  });

  it("isCloseTabChord matches plain Ctrl+D only", () => {
    const e = event("KeyD");
    expect(isCloseTabChord(e({ ctrlKey: true }))).toBe(true);
    expect(isCloseTabChord(e({}))).toBe(false);
    expect(isCloseTabChord(e({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCloseTabChord(e({ metaKey: true }))).toBe(false);
    expect(isCloseTabChord(e({ ctrlKey: true, code: "KeyW" }))).toBe(false);
  });

  it("isCycleChord matches Ctrl+Tab, with or without shift", () => {
    const e = event("Tab");
    expect(isCycleChord(e({ ctrlKey: true }))).toBe(true);
    // Shift reverses the direction; it is still the chord.
    expect(isCycleChord(e({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCycleChord(e({}))).toBe(false);
    expect(isCycleChord(e({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCycleChord(e({ metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isCycleChord(e({ ctrlKey: true, code: "KeyTab" }))).toBe(false);
  });
});

describe("closeDecision", () => {
  it("asks the question for a window that still holds tabs", () => {
    expect(closeDecision(fakeDoc({ ".tabs": 1, ".tabs .tab": 2 }))).toBe("prompt");
  });

  it("discards an empty window outright", () => {
    // An empty window must never be recorded. Emptiness is the welcome
    // surface, which renders only when NEITHER Hybrid side holds a tab, not
    // the strip, which lists one side.
    expect(closeDecision(fakeDoc({ ".tabs": 1, ".welcome": 1 }))).toBe("discard");
  });

  it("keeps a window whose hidden side still holds tabs", () => {
    // The strip is empty but chan shows the minimal mark rather than the
    // welcome, so the window is not empty.
    expect(
      closeDecision(fakeDoc({ ".tabs": 1, ".tabs .tab": 0, ".placeholder-mark": 1 })),
    ).toBe("prompt");
  });

  it("discards a window behind the reconnect overlay", () => {
    // There is nothing left to interact with.
    expect(closeDecision(fakeDoc({ ".overlay .spinner": 1, ".tabs": 1, ".tabs .tab": 3 }))).toBe(
      "discard",
    );
  });

  it("measures a terminal window by its strip, which never shows the welcome", () => {
    expect(closeDecision(fakeDoc({ ".tabs": 1, ".tabs .tab": 0 }), "terminal")).toBe("discard");
    expect(closeDecision(fakeDoc({ ".tabs": 1, ".tabs .tab": 1 }), "terminal")).toBe("prompt");
  });

  it("never guesses", () => {
    // An unrendered layout, a missing document, or a document that throws (a
    // cross-origin frame) all prompt rather than risk a session.
    expect(closeDecision(fakeDoc({}))).toBe("prompt");
    expect(closeDecision(null)).toBe("prompt");
    expect(
      closeDecision({
        querySelector() {
          throw new Error("cross-origin");
        },
      }),
    ).toBe("prompt");
  });
});

describe("closesWindowOnCloseTab", () => {
  it("fires for the last pane of an empty window", () => {
    expect(closesWindowOnCloseTab(fakeDoc({ ".tabs": 1, ".welcome": 1 }))).toBe(true);
    // A terminal window empties when its strip does.
    expect(closesWindowOnCloseTab(fakeDoc({ ".tabs": 1, ".tabs .tab": 0 }), "terminal")).toBe(true);
  });

  it("stays out of the way while the SPA has something to close", () => {
    // Still holding a tab: the SPA closes the tab.
    expect(closesWindowOnCloseTab(fakeDoc({ ".tabs": 1, ".tabs .tab": 1 }))).toBe(false);
    // More than one pane: the SPA closes the pane, not the window.
    expect(closesWindowOnCloseTab(fakeDoc({ ".tabs": 2, ".welcome": 1 }))).toBe(false);
  });

  it("never closes a window from an unknown state", () => {
    // Ctrl+D stays the SPA's, and a shell's EOF.
    expect(closesWindowOnCloseTab(null)).toBe(false);
    expect(
      closesWindowOnCloseTab({
        querySelectorAll() {
          throw new Error("cross-origin");
        },
      }),
    ).toBe(false);
  });
});

describe("nextFrameId", () => {
  const ids = ["w-1", "w-2", "w-3"];

  it("walks the windows in order and wraps both ways", () => {
    expect(nextFrameId(ids, "w-1")).toBe("w-2");
    expect(nextFrameId(ids, "w-3")).toBe("w-1");
    expect(nextFrameId(ids, "w-1", true)).toBe("w-3");
    expect(nextFrameId(ids, "w-2", true)).toBe("w-1");
  });

  it("enters at the ends when no window is current", () => {
    // The launcher is focused, or the caller's window has gone.
    expect(nextFrameId(ids, null)).toBe("w-1");
    expect(nextFrameId(ids, null, true)).toBe("w-3");
    expect(nextFrameId(ids, "gone")).toBe("w-1");
  });

  it("handles the empty and lone-window cases", () => {
    expect(nextFrameId([], "w-1")).toBeNull();
    expect(nextFrameId(["w-1"], "w-1")).toBe("w-1");
  });
});

describe("newWindowRequest", () => {
  const ws = {
    window_id: "w-1",
    kind: "workspace",
    workspace_path: "/home/u/notes",
    prefix: "/notes-1a2b",
  };
  const leaders = { "/notes-1a2b": "w-1", "/api/terminal": "w-9" };

  it("opens another window of a focused workspace's family, claiming the leader", () => {
    expect(newWindowRequest("frame", ws, leaders)).toEqual({
      kind: "workspace",
      workspace_path: "/home/u/notes",
      acting_window_id: "w-1",
    });
  });

  it("claims nothing from a follower", () => {
    // The server allows an absent claim but 403s a mismatching one.
    expect(newWindowRequest("frame", { ...ws, window_id: "w-2" }, leaders)).toEqual({
      kind: "workspace",
      workspace_path: "/home/u/notes",
      acting_window_id: undefined,
    });
  });

  it("opens another terminal from a focused terminal", () => {
    expect(
      newWindowRequest("frame", { window_id: "w-9", kind: "terminal", prefix: "/api/terminal" }, leaders),
    ).toEqual({ kind: "terminal", acting_window_id: "w-9" });
  });

  it("opens a standalone terminal from the launcher or from nothing", () => {
    expect(newWindowRequest("launcher", null, leaders)).toEqual({ kind: "terminal" });
    expect(newWindowRequest("frame", null, leaders)).toEqual({ kind: "terminal" });
  });

  it("tolerates the leading-slash difference in the leaders map", () => {
    expect(tenantLeader({ "notes-1a2b": "w-3" }, "/notes-1a2b")).toBe("w-3");
    expect(tenantLeader({ "/notes-1a2b": "w-3" }, "notes-1a2b")).toBe("w-3");
    expect(tenantLeader({}, "/notes-1a2b")).toBeUndefined();
  });
});

describe("makeFakeWindow", () => {
  it("satisfies the SPA popup contract", () => {
    const events = [];
    const fake = makeFakeWindow({
      name: "",
      onNavigate: (f, url) => {
        events.push(["nav", url]);
        return `${ORIGIN}${url}`;
      },
      onFocus: () => events.push(["focus"]),
      onClose: () => events.push(["close"]),
    });

    // popupNeedsNavigation() from workspace-app libraryWindows.
    expect(fake.location.href).toBe("about:blank");
    expect(fake.closed).toBe(false);

    // clearClonedSessionDeckDrafts iterates sessionStorage backwards.
    expect(fake.sessionStorage.length).toBe(0);
    expect(fake.sessionStorage.key(0)).toBeNull();
    fake.sessionStorage.removeItem("x");

    // createLibraryWindow: popup.name = id; popup.location.href = path; focus().
    fake.name = "w-9";
    fake.location.href = "/p/?w=w-9";
    expect(fake.location.href).toBe(`${ORIGIN}/p/?w=w-9`);
    fake.focus();

    // windowManager mintWindow uses blank.location.href; whole-property
    // assignment must work too.
    fake.location = "/p/?w=w-9&x=1";
    expect(fake.location.href).toBe(`${ORIGIN}/p/?w=w-9&x=1`);

    // A second close is inert.
    fake.close();
    fake.close();
    expect(fake.closed).toBe(true);
    expect(events).toEqual([
      ["nav", "/p/?w=w-9"],
      ["focus"],
      ["nav", "/p/?w=w-9&x=1"],
      ["close"],
    ]);
  });
});

describe("createOpenShim", () => {
  it("passes through on the OS destination, forwarding the features string", () => {
    const calls = [];
    const shim = createOpenShim({
      destination: () => "os",
      realOpen: (url, target, features) => {
        calls.push([url, target, features]);
        return "real";
      },
      lookupNamed: () => null,
      makeFake: () => {
        throw new Error("no fake on the OS path");
      },
    });
    expect(shim("", "_blank")).toBe("real");
    expect(shim("https://x.test/", "_blank", "noopener,noreferrer")).toBe("real");
    expect(shim("/p/?w=w-1", "w-1")).toBe("real");
    expect(calls).toEqual([
      ["", "_blank", undefined],
      ["https://x.test/", "_blank", "noopener,noreferrer"],
      ["/p/?w=w-1", "w-1", undefined],
    ]);
  });

  it("reaches a live named Hybrid frame even when the switch says OS", () => {
    // The switch governs where the NEXT window opens; focusing or burying a
    // window that already lives in Hybrid must still reach that frame.
    const fake = makeFakeWindow({ name: "w-1", onNavigate: (f, u) => u });
    fake.location.href = "/p/?w=w-1";
    const shim = createOpenShim({
      destination: () => "os",
      realOpen: () => {
        throw new Error("focus/bury of a Hybrid-owned window must not open an OS window");
      },
      lookupNamed: (name) => (name === "w-1" ? fake : null),
      makeFake: () => {
        throw new Error("no new fake either");
      },
    });
    expect(shim("/p/?w=w-1", "w-1")).toBe(fake);
    expect(shim("", "w-1")).toBe(fake);
  });

  it("mints fakes and reuses named handles on the hybrid destination", () => {
    const named = new Map();
    const shim = createOpenShim({
      destination: () => "hybrid",
      realOpen: () => {
        throw new Error("no real open on the hybrid path");
      },
      lookupNamed: (name) => named.get(name) || null,
      makeFake: (name) => makeFakeWindow({ name, onNavigate: (f, u) => u }),
    });

    expect(shim("", "_blank").location.href).toBe("about:blank");

    const fresh = shim("", "w-5");
    expect(fresh.name).toBe("w-5");
    named.set("w-5", fresh);

    // A second named open returns the same handle (the focus-reuse flow).
    const again = shim("/p/?w=w-5", "w-5");
    expect(again).toBe(fresh);
    expect(again.location.href).toBe("/p/?w=w-5");

    // A closed handle is not reused.
    fresh.close();
    expect(shim("", "w-5")).not.toBe(fresh);
  });
});

describe("reconcileFrames", () => {
  const now = 1_000_000;

  it("separates discards, buries and retitles, sparing young and unmanaged frames", () => {
    const frames = [
      { id: "w-live", managed: true, hidden: false, createdAt: 0 },
      { id: "w-gone-old", managed: true, hidden: false, createdAt: now - FRAME_GRACE_MS },
      { id: "w-gone-young", managed: true, hidden: false, createdAt: now - FRAME_GRACE_MS + 1000 },
      { id: "w-to-hide", managed: true, hidden: false, createdAt: 0 },
      { id: "w-to-show", managed: true, hidden: true, createdAt: 0 },
      { id: "anon-1", managed: false, hidden: false, createdAt: 0 },
    ];
    const records = new Map([
      ["w-live", { window_id: "w-live", kind: "workspace", ordinal: 1 }],
      ["w-to-hide", { window_id: "w-to-hide", kind: "workspace", ordinal: 2, hidden: true }],
      ["w-to-show", { window_id: "w-to-show", kind: "workspace", ordinal: 3, hidden: false }],
    ]);
    const plan = reconcileFrames(frames, records, now, { owned: new Set(["w-to-hide"]) });
    // A vanished record retires its frame; a frame younger than the grace
    // window is left alone because its mint may not have reached the feed.
    expect(plan.discard).toEqual(["w-gone-old"]);
    // A hidden record tears its frame down, and is never rebuilt.
    expect(plan.bury).toEqual(["w-to-hide"]);
    expect(plan.build).toEqual([]);
    expect(plan.retitle.map((r) => r.id).sort()).toEqual(["w-live", "w-to-show"]);
  });

  it("rebuilds an owned window that came back, and adopts on the first snapshot", () => {
    const revived = { window_id: "w-1", kind: "workspace", ordinal: 1, prefix: "/p", hidden: false };
    const foreign = { window_id: "w-2", kind: "workspace", ordinal: 2, prefix: "/p", connected: true };
    const orphan = { window_id: "w-3", kind: "terminal", ordinal: 1, prefix: "/t" };
    const records = new Map([
      ["w-1", revived],
      ["w-2", foreign],
      ["w-3", orphan],
    ]);

    // Steady state: only windows this shell owns are rebuilt, and a record
    // connected elsewhere (a real OS window) is left alone.
    expect(reconcileFrames([], records, now, { owned: new Set(["w-1"]) }).build).toEqual([revived]);

    // First snapshot after a reload: adopt every visible record nothing else
    // is running, the way the desktop watcher restores its windows at boot.
    expect(reconcileFrames([], records, now, { owned: new Set(), adopt: true }).build).toEqual([
      revived,
      orphan,
    ]);

    // A window that already has a frame is never rebuilt.
    expect(
      reconcileFrames([{ id: "w-1", managed: true, createdAt: now }], records, now, {
        owned: new Set(["w-1"]),
      }).build,
    ).toEqual([]);
  });
});

describe("frameTitle", () => {
  it("recomposes chan's shared window-label spelling", () => {
    expect(frameTitle({ kind: "workspace", ordinal: 1 })).toBe("Window 1");
    expect(frameTitle({ kind: "terminal", ordinal: 2 })).toBe("Terminal Window 2");
    expect(frameTitle({ kind: "workspace", ordinal: 3, label: " logs " })).toBe("Window 3 [logs]");
    expect(frameTitle({ kind: "terminal", ordinal: 0, control: true })).toBe("Control terminal");
    expect(frameTitle({ kind: "workspace", ordinal: 4, label: "" })).toBe("Window 4");
  });
});

describe("destination and backoff", () => {
  it("defaults an unknown destination to hybrid", () => {
    expect(normalizeDestination("os")).toBe("os");
    expect(normalizeDestination("hybrid")).toBe("hybrid");
    expect(normalizeDestination(null)).toBe("hybrid");
    expect(normalizeDestination("junk")).toBe("hybrid");
  });

  it("follows the launcher's reconnect curve", () => {
    expect(watchBackoff(0)).toBe(500);
    expect(watchBackoff(1)).toBe(1000);
    expect(watchBackoff(10)).toBe(15000);
  });
});

describe("collapse", () => {
  it("defaults to neither side collapsed, and rejects anything else", () => {
    expect(normalizeCollapse(null)).toBe("none");
    expect(normalizeCollapse("junk")).toBe("none");
    expect(normalizeCollapse("dock")).toBe("dock");
    expect(normalizeCollapse("desktop")).toBe("desktop");
  });

  it("collapses a side, and restores it when clicked again", () => {
    expect(toggleCollapse("none", "dock")).toBe("dock");
    expect(toggleCollapse("dock", "dock")).toBe("none");
    expect(toggleCollapse("none", "desktop")).toBe("desktop");
    expect(toggleCollapse("desktop", "desktop")).toBe("none");
  });

  it("never leaves both sides collapsed", () => {
    // Collapsing the other side moves the collapse rather than adding one:
    // a window with the launcher and the windows both hidden has nothing in it.
    expect(toggleCollapse("dock", "desktop")).toBe("desktop");
    expect(toggleCollapse("desktop", "dock")).toBe("dock");
    for (const from of ["none", "dock", "desktop"]) {
      for (const side of ["dock", "desktop"]) {
        expect(["none", "dock", "desktop"]).toContain(toggleCollapse(from, side));
      }
    }
  });
});

describe("frame identity", () => {
  // The watcher keys a window it placed by its native label; a frame this shell
  // opened itself is keyed by the bare window_id. A caller reaching for a
  // window by id has to find it under either key, or it builds a SECOND frame
  // onto the same session and the two mirror each other's input.
  const windowIdOf = (id) => {
    const at = String(id).indexOf("::");
    return at < 0 ? id : id.slice(at + 2);
  };

  it("reads the window id out of either key", () => {
    expect(windowIdOf("local::w-abc")).toBe("w-abc");
    expect(windowIdOf("lib-9f2::w-abc")).toBe("w-abc");
    expect(windowIdOf("w-abc")).toBe("w-abc");
  });

  it("matches a native label against the bare id it carries", () => {
    // This is the comparison frameIdFor() makes; getting it wrong is the
    // duplicate-frame bug.
    const frames = ["local::w-one", "w-two"];
    const find = (id) => frames.find((f) => windowIdOf(f) === id) ?? null;
    expect(find("w-one")).toBe("local::w-one");
    expect(find("w-two")).toBe("w-two");
    expect(find("w-three")).toBeNull();
  });
});

describe("geometry", () => {
  it("round-trips through a storage stub and survives junk", () => {
    const store = new Map();
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    };
    saveGeometry(storage, "w-1", { x: 1, y: 2, width: 300, height: 200, max: false });
    expect(loadGeometry(storage, "w-1")).toEqual({
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      max: false,
    });
    store.set("chan-hybrid.geo.w-2", "{junk");
    expect(loadGeometry(storage, "w-2")).toBeNull();
    expect(loadGeometry(storage, "w-3")).toBeNull();
  });
});

describe("cascadePlacement", () => {
  it("staggers within the usable area", () => {
    const area = { left: 420, top: 44, width: 1500, height: 900 };
    const first = cascadePlacement(0, area);
    expect(first.x).toBe(420);
    expect(first.y).toBe(44);
    const third = cascadePlacement(2, area);
    expect(third.x).toBe(420 + 56);
    expect(third.y).toBe(44 + 56);
    expect(first.width).toBeLessThanOrEqual(1100);
    expect(first.height).toBeLessThanOrEqual(760);
  });

  it("holds the size floor on a tiny viewport", () => {
    expect(cascadePlacement(0, { left: 0, top: 0, width: 200, height: 100 }).width).toBe(320);
  });
});
