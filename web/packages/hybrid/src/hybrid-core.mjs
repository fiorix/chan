// Pure logic for the Hybrid shell: everything here is DOM-free so it runs
// under vitest as well as in the page. The contracts mirror the launcher's
// windowManager/windowUrl and the workspace app's libraryWindows, which are the
// surfaces the shell has to speak to unchanged.

export const DESTINATION_KEY = "chan-hybrid.destination";
export const COLLAPSE_KEY = "chan-hybrid.collapsed";
export const GEOMETRY_KEY_PREFIX = "chan-hybrid.geo.";
// The launcher bearer, seeded from the `?t=` the host window is opened with and
// held in sessionStorage so a reload inside the host survives the strip.
export const TOKEN_KEY = "chan-hybrid.token";

// A frame minted moments ago may not have reached the watch feed yet; the
// reconciler must not treat that gap as a discard.
export const FRAME_GRACE_MS = 5000;

export function normalizeDestination(value) {
  return value === "os" ? "os" : "hybrid";
}

// Which half of the window is collapsed: the launcher dock, the window-manager
// desktop, or neither. One value rather than a flag each, because the two are
// mutually exclusive by construction -- collapsing both would leave a window
// with nothing in it, and a state that cannot be represented cannot be reached.
export function normalizeCollapse(value) {
  return value === "dock" || value === "desktop" ? value : "none";
}

/** What a collapse control does when clicked. Clicking the side that is already
 * collapsed restores it; clicking the other side moves the collapse there,
 * which is what keeps exactly one side (at most) hidden. */
export function toggleCollapse(current, side) {
  return normalizeCollapse(current) === side ? "none" : normalizeCollapse(side);
}

// Mirror of the launcher's windowUrl(record, origin): the same-origin in-app
// URL for a window record, with ?w= always stamped so the SPA keys its
// session on the record instead of minting a random per-tab id.
export function windowUrlFor(record, origin, { hosted = false } = {}) {
  const prefix = String(record.prefix || "").replace(/^\/+|\/+$/g, "");
  const url = new URL(origin);
  url.pathname = `/${prefix}/`;
  url.searchParams.set("w", record.window_id);
  if (record.kind === "terminal") {
    url.searchParams.set("kind", record.control ? "control" : "terminal");
  }
  if (record.library_id) url.searchParams.set("lib", record.library_id);
  if (record.token) url.searchParams.set("t", record.token);
  // `hybrid=1` tells the SPA to take the NATIVE chord set, because the host
  // installs the same key bridge into its frames that a native window gets.
  // Only under a host: served in a plain browser there is no bridge to install,
  // and claiming the native chords there would advertise chords that do
  // nothing. Tauri's own markers cannot carry this either way -- it injects
  // them into the main frame only.
  if (hosted) url.searchParams.set("hybrid", "1");
  return url.toString();
}

export function windowIdFromUrl(urlStr, base) {
  try {
    return new URL(urlStr, base).searchParams.get("w");
  } catch {
    return null;
  }
}

// CmdOrCtrl+Shift+N, the chan-desktop New Window accelerator. Alt excluded so
// AltGr combinations cannot alias into it.
export function isNewWindowChord(event) {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.code === "KeyN"
  );
}

// chan's shared window-label contract (web-shared/window-label.ts): every
// surface recomposes the display name from kind/ordinal/label and never
// parses the library-composed `title`.
// What a red-dot close should do, mirroring the decision chan-desktop makes
// before it prompts. The native side hands a live window's close to the SPA,
// and the SPA (App.svelte's `app.window.confirmClose`) closes straight away,
// discarding the window, in two cases: it is sitting behind the reconnect
// overlay, so there is nothing left to interact with, or it has no tabs at
// all, because an empty window must never be recorded. Everything else
// prompts.
//
// The shell reads those two states from the window's own DOM, since it holds
// the frame rather than the SPA's state. It answers "prompt" whenever it
// cannot tell (the layout has not rendered, the document is unreachable):
// prompting a window that could have closed silently is a small annoyance,
// while discarding one that still holds tabs loses a session.
export function closeDecision(doc, kind) {
  try {
    if (!doc) return "prompt";
    if (doc.querySelector(".overlay .spinner")) return "discard";
    if (!doc.querySelector(".tabs")) return "prompt";
    return windowIsEmpty(doc, kind) ? "discard" : "prompt";
  } catch {
    return "prompt";
  }
}

/** Whether a window holds no tabs at all, chan's `hasAnyTab()`.
 *
 * The tab strip is NOT the measure: it lists one Hybrid side, while
 * `paneHasAnyTabs` counts both (`p.tabs || p.bTabs`), so a pane whose hidden
 * side still holds tabs shows an empty strip. A workspace window renders
 * EmptyPaneWelcome exactly when its lone pane has nothing on either side, and
 * shows the minimal mark instead when the hidden side is occupied, so that
 * surface is the honest signal. A terminal window never renders the welcome
 * (it is expected to always hold a terminal), so there the empty strip is the
 * measure. A multi-pane window renders no welcome either, so it reads as
 * non-empty and prompts: erring toward the question is what keeps a session
 * that still exists from being discarded. */
export function windowIsEmpty(doc, kind) {
  if (kind === "terminal") {
    return Boolean(doc.querySelector(".tabs")) && doc.querySelectorAll(".tabs .tab").length === 0;
  }
  return Boolean(doc.querySelector(".welcome"));
}

// chan's close-tab chord. Ctrl+D must still reach a focused shell as EOF, so
// the shell claims it only when the window has no tabs at all, where there is
// no terminal to reach.
export function isCloseTabChord(event) {
  return (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.code === "KeyD"
  );
}

/** Whether close-tab should close the WINDOW: chan closes the active empty
 * pane, and when that was the last pane the window goes with it
 * (`closeActiveEmptyPane` -> `leafPaneCount() <= 1`). The SPA performs that
 * last step only on the desktop and declines on the web, so the shell plays
 * the host's half. With more than one pane the SPA closes the pane itself and
 * the shell stays out of the way. */
export function closesWindowOnCloseTab(doc, kind) {
  try {
    if (!doc) return false;
    if (doc.querySelectorAll(".tabs").length !== 1) return false;
    return windowIsEmpty(doc, kind);
  } catch {
    return false;
  }
}

// Ctrl+Tab cycles the windows inside Hybrid, the analogue of macOS's Cmd+`
// for an app's windows; Shift reverses it. A browser tab strip claims this
// chord before the page, so in practice it is a chan-desktop affordance: a
// Tauri webview has no tabs of its own and delivers it.
export function isCycleChord(event) {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Tab";
}

/** The next window in cycle order, wrapping. Order is the window manager's
 * own (creation) order rather than most-recently-used, so repeated presses
 * walk the windows predictably instead of flipping between two. A caller
 * with no current window (the launcher is focused) enters at the ends. */
export function nextFrameId(ids, currentId, backwards = false) {
  if (!ids.length) return null;
  const at = ids.indexOf(currentId);
  if (at < 0) return backwards ? ids[ids.length - 1] : ids[0];
  const step = backwards ? -1 : 1;
  return ids[(at + step + ids.length) % ids.length];
}

export function frameTitle(record) {
  if (record.control) return "Control terminal";
  const generated =
    record.kind === "terminal"
      ? `Terminal Window ${record.ordinal}`
      : `Window ${record.ordinal}`;
  const label = record.label ? String(record.label).trim() : "";
  return label ? `${generated} [${label}]` : generated;
}

// The leader window_id for a record's tenant, tolerant of the leading-slash
// difference between record prefixes and leaders-map keys.
export function tenantLeader(leaders, prefix) {
  if (!leaders || !prefix) return undefined;
  const bare = String(prefix).replace(/^\/+/, "");
  return leaders[prefix] ?? leaders[`/${bare}`] ?? leaders[bare];
}

// chan-desktop's New Window menu routing: a focused workspace window opens
// another window of its workspace, a focused terminal opens another terminal,
// the launcher (or nothing) focused opens a standalone terminal. The
// acting_window_id leader claim mirrors the launcher's actingFor(): claim
// only when the focused window IS its tenant's leader; an absent claim is
// allowed by the server where a mismatching one is 403'd.
export function newWindowRequest(focused, record, leaders) {
  if (focused === "frame" && record) {
    const acting =
      tenantLeader(leaders, record.prefix) === record.window_id
        ? record.window_id
        : undefined;
    if (record.kind === "workspace" && record.workspace_path) {
      return {
        kind: "workspace",
        workspace_path: record.workspace_path,
        acting_window_id: acting,
      };
    }
    return { kind: "terminal", acting_window_id: acting };
  }
  return { kind: "terminal" };
}

// The launcher's watch-feed reconnect curve: 0.5s doubling to a 15s cap.
export function watchBackoff(attempt) {
  return Math.min(15000, 500 * 2 ** attempt);
}

// The subset of the WindowProxy surface chan's SPAs touch on their
// window.open handles: closed, name, focus(), close(), location.href
// get/set (plus assign/replace and whole-property assignment), and an
// enumerable-but-empty sessionStorage for clearClonedSessionDeckDrafts.
// A fresh handle answers "about:blank" so popupNeedsNavigation() holds.
export function makeFakeWindow(hooks = {}) {
  const fake = {};
  let href = "about:blank";
  function navigate(value) {
    const target = String(value);
    const resolved = hooks.onNavigate ? hooks.onNavigate(fake, target) : target;
    href = resolved ?? target;
  }
  const location = {
    get href() {
      return href;
    },
    set href(value) {
      navigate(value);
    },
    assign: navigate,
    replace: navigate,
    toString: () => href,
  };
  Object.defineProperty(fake, "location", {
    get: () => location,
    set: (value) => navigate(value),
  });
  fake.closed = false;
  fake.name = hooks.name || "";
  fake.opener = null;
  fake.focus = () => hooks.onFocus && hooks.onFocus(fake);
  fake.blur = () => {};
  fake.postMessage = () => {};
  fake.close = () => {
    if (fake.closed) return;
    fake.closed = true;
    if (hooks.onClose) hooks.onClose(fake);
  };
  fake.sessionStorage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
  };
  return fake;
}

// window.open replacement installed into the launcher and every tenant frame.
// On the OS destination the real open runs and chan behaves exactly as today;
// on Hybrid the returned handle is a fake whose navigations open WM frames.
// Named reuse is checked BEFORE the destination: focusing or burying a window
// that already lives in Hybrid must reach that frame even when the switch has
// since been flipped to OS (the switch governs where the NEXT window opens).
export function createOpenShim(deps) {
  return function shimOpen(url, target, features) {
    const name = target && target !== "_blank" ? String(target) : "";
    if (name === "_self" || name === "_parent" || name === "_top") {
      return deps.realOpen(url, name, features);
    }
    if (name) {
      const existing = deps.lookupNamed(name);
      if (existing && !existing.closed) {
        if (url) existing.location.href = String(url);
        return existing;
      }
    }
    if (deps.destination() === "os") {
      return deps.realOpen(url, target || "_blank", features);
    }
    const fake = deps.makeFake(name);
    if (url) fake.location.href = String(url);
    return fake;
  };
}

// Diff the open WM frames against the current watch-feed record set.
//
// A hidden record DESTROYS its frame, which is chan's actual bury contract
// rather than a visual trick: the server pushes a terminal window_hidden
// teardown to that window's own socket and never signals an un-hide, so a
// surviving SPA would sit behind a dead "hidden by the session leader"
// overlay forever. chan-desktop does the same thing (the watcher closes the
// webview) and loses nothing by it: terminals keep running server-side and
// the layout comes back from session.json when the window is rebuilt at its
// stable ?w=. `bury` keeps the window's handle so the frame can be revived;
// `discard` retires it because the record itself is gone.
//
// A visible record with no frame is (re)built when this shell owns it, and
// on the first snapshot after a reload it adopts any visible record nothing
// else is running, the way the desktop watcher restores its windows at boot.
// Frames younger than FRAME_GRACE_MS without a record are left alone (the
// mint has not reached the feed yet), as are frames never bound to a record.
export function reconcileFrames(frames, recordsById, now, opts = {}) {
  const owned = opts.owned || new Set();
  const discard = [];
  const bury = [];
  const build = [];
  const retitle = [];
  const framed = new Set();
  for (const frame of frames) {
    if (!frame.managed) continue;
    framed.add(frame.id);
    const record = recordsById.get(frame.id);
    if (!record) {
      if (now - frame.createdAt >= FRAME_GRACE_MS) discard.push(frame.id);
      continue;
    }
    if (record.hidden) {
      bury.push(frame.id);
      continue;
    }
    retitle.push({ id: frame.id, title: frameTitle(record) });
  }
  for (const record of recordsById.values()) {
    if (record.hidden || framed.has(record.window_id)) continue;
    if (record.connected) continue; // live somewhere else (an OS window)
    if (owned.has(record.window_id) || opts.adopt) build.push(record);
  }
  return { discard, bury, build, retitle };
}

export function loadGeometry(storage, id) {
  try {
    const raw = storage.getItem(GEOMETRY_KEY_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveGeometry(storage, id, geometry) {
  try {
    storage.setItem(GEOMETRY_KEY_PREFIX + id, JSON.stringify(geometry));
  } catch {
    // Storage denial just loses geometry restore.
  }
}

// Staggered default placement inside the usable desktop area.
export function cascadePlacement(index, area) {
  const width = Math.max(320, Math.min(1100, Math.round(area.width * 0.72)));
  const height = Math.max(240, Math.min(760, Math.round(area.height * 0.78)));
  const step = 28 * (index % 8);
  const x = Math.min(area.left + step, Math.max(area.left, area.left + area.width - width));
  const y = Math.min(area.top + step, Math.max(area.top, area.top + area.height - height));
  return { x, y, width, height };
}
