// Hybrid shell glue: docks the real launcher, installs the window.open shim +
// keyboard capture into every same-origin frame, and reconciles WM frames
// against the library watch feed.
//
// The shell is served by chan-server under /__hybrid/, which puts it on the
// same origin as the launcher at `/` and every tenant at `/{prefix}/`. That is
// what lets it reach into its frames at all; a shell served from the desktop's
// custom protocol would be cross-origin with both.

import "./vendor/winbox.bundle.min.js";
// As text, not as a stylesheet: it is injected into the launcher's own document
// (see injectDestinationSwitch), which the shell's stylesheet cannot reach.
import DESTINATION_SWITCH_CSS from "./destination-switch.css?inline";
import {
  COLLAPSE_KEY,
  DESTINATION_KEY,
  TOKEN_KEY,
  closeDecision,
  closesWindowOnCloseTab,
  createOpenShim,
  frameTitle,
  isCloseTabChord,
  isCycleChord,
  isNewWindowChord,
  makeFakeWindow,
  newWindowRequest,
  nextFrameId,
  normalizeCollapse,
  normalizeDestination,
  reconcileFrames,
  toggleCollapse,
  watchBackoff,
  windowUrlFor,
} from "./hybrid-core.mjs";
import * as host from "./host-bridge.mjs";
import { createWinboxWm } from "./wm-winbox.mjs";

const els = {
  dock: document.getElementById("dock"),
  dockToggle: document.getElementById("dock-toggle"),
  desktopToggle: document.getElementById("desktop-toggle"),
  launcher: document.getElementById("launcher"),
  zoomMenu: document.getElementById("zoom-menu"),
  closePrompt: document.getElementById("close-prompt"),
  notices: document.getElementById("notices"),
  error: document.getElementById("error"),
};

const state = {
  boot: null,
  records: new Map(), // window_id -> WindowRecord (last watch push)
  leaders: {}, // tenant prefix -> leader window_id (last watch push)
  fakes: new Map(), // window_id -> fake WindowProxy handle
  blanks: new Set(), // fakes not yet bound to a window_id
  fakeIds: new WeakMap(), // fake -> window_id
  anonSeq: 0,
  restored: false,
  // Whether chan-desktop is hosting this page. Under a host the window watcher
  // owns which windows exist and the shell renders what it is told; standalone
  // (a devserver in a browser tab) the shell is its own authority and drives
  // the library API directly. The two differ in enough places that the flag is
  // read rather than re-derived.
  hosted: false,
};

// Frames the window watcher owns are keyed by its native label,
// `{library_id}::{window_id}`, because that is the identity its reconcile
// speaks. Frames the shell opened itself through the `window.open` shim are
// keyed by the bare window_id: those are browser-origin records the watcher
// deliberately never opens, so they have no native label to use.
function isNativeLabel(id) {
  return typeof id === "string" && id.includes("::");
}

function windowIdOf(id) {
  const at = String(id).indexOf("::");
  return at < 0 ? id : id.slice(at + 2);
}

// The frame showing a given window, whichever key it is under: the watcher's
// native label for a window it placed, or the bare window_id for one this shell
// opened itself. Callers that reach for a window by id must find it either way,
// or they build a second frame onto the same session and the two mirror.
function frameIdFor(windowId) {
  if (wm.has(windowId)) return windowId;
  const framed = wm.list().find((frame) => windowIdOf(frame.id) === windowId);
  return framed ? framed.id : null;
}

/// Tell the host which windows it holds frames for. This IS `open_labels` for
/// the Hybrid surface, so it goes out on every frame change; only the
/// watcher-owned frames are reported, since the others are windows it does not
/// know about.
function reportFrames() {
  if (!state.hosted || !wm) return Promise.resolve(null);
  return host.reportFrames(wm.list().map((frame) => frame.id).filter(isNativeLabel));
}

// Take the host's destination as the truth. The shell's localStorage copy
// serves the surface with no host and defaults the other way, so adopting the
// answer is what keeps the switch honest about where the next window goes.
function adoptHostDestination(destination) {
  if (!destination) return;
  localStorage.setItem(DESTINATION_KEY, normalizeDestination(destination));
  renderDestinationControls();
}

let wm = null;

// ---------------------------------------------------------------- destination

function getDestination() {
  return normalizeDestination(localStorage.getItem(DESTINATION_KEY));
}

function setDestination(value) {
  const next = normalizeDestination(value);
  localStorage.setItem(DESTINATION_KEY, next);
  // Under a host the switch it holds is the one that matters: the watcher
  // consults it when it places a window, long before any of this page's code
  // runs. localStorage stays the source for the standalone surface, and keeps
  // the control rendering correctly before the host answers.
  if (state.hosted) host.setDestination(next);
  renderDestinationControls();
}

const FLIP_DURATION_MS = 520;

function destinationLabel(dest) {
  return dest === "os" ? "OS" : "Hybrid";
}

function destinationControl(doc) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "hybrid-dest";
  const inner = doc.createElement("span");
  inner.className = "hybrid-dest-inner";
  const face = doc.createElement("span");
  face.className = "hybrid-dest-face";
  inner.appendChild(face);
  button.appendChild(inner);
  button.addEventListener("click", () => flipDestination());
  syncDestinationControl(button);
  return button;
}

function syncDestinationControl(button) {
  const dest = getDestination();
  const label = destinationLabel(dest);
  button.dataset.dest = dest;
  button.title =
    dest === "os"
      ? "The next window opens on the OS window manager. Click for Hybrid."
      : "The next window opens inside Hybrid. Click for the OS window manager.";
  button.setAttribute("aria-label", `Next window opens: ${label}`);
  const face = button.querySelector(".hybrid-dest-face");
  const inner = button.querySelector(".hybrid-dest-inner");
  if (face) face.textContent = label;
  if (inner) inner.dataset.flipLabel = label;
}

// The switch lives in the docked launcher's top bar and nowhere else: the shell
// has no chrome of its own, and that bar is where chan already puts its global
// controls.
function eachDestinationControl(fn) {
  let doc = null;
  try {
    doc = els.launcher.contentDocument;
  } catch {
    return; // cross-origin launcher: nothing to reach into
  }
  if (!doc) return;
  for (const button of doc.querySelectorAll(".hybrid-dest")) fn(button);
}

// Insert the control into the launcher's top bar, next to the command-launcher
// and select buttons. The launcher mounts asynchronously, so observe until the
// actions group exists.
function injectDestinationSwitch(doc) {
  const style = doc.createElement("style");
  style.textContent = DESTINATION_SWITCH_CSS;
  doc.head.appendChild(style);
  const tryInsert = () => {
    const actions = doc.querySelector("header.topbar .actions");
    if (!actions) return false;
    if (!actions.querySelector(".hybrid-dest")) {
      actions.insertBefore(destinationControl(doc), actions.firstChild);
      renderDestinationControls();
    }
    return true;
  };
  if (tryInsert()) return;
  const observer = new MutationObserver(() => {
    if (tryInsert()) observer.disconnect();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
}

function renderDestinationControls() {
  eachDestinationControl(syncDestinationControl);
}

function flipDestination() {
  setDestination(getDestination() === "os" ? "hybrid" : "os");
  eachDestinationControl((button) => {
    button.classList.remove("flipping");
    // Restart the animation on a rapid second click.
    void button.offsetWidth;
    button.classList.add("flipping");
    setTimeout(() => button.classList.remove("flipping"), FLIP_DURATION_MS + 80);
  });
}

// ------------------------------------------------------------------- notices

function notice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  els.notices.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ----------------------------------------------------------------- library API

async function apiCall(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (state.boot.token) headers.authorization = `Bearer ${state.boot.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${detail}`.trim());
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function apiPost(path, body) {
  return apiCall("POST", path, body);
}

function apiDelete(path) {
  return apiCall("DELETE", path);
}

// ------------------------------------------------------------------ fakes/WM

function bindFake(fake, id) {
  state.blanks.delete(fake);
  state.fakeIds.set(fake, id);
  state.fakes.set(id, fake);
}

function dropFake(id, { markClosed = false } = {}) {
  const fake = state.fakes.get(id);
  if (fake && markClosed) fake.closed = true;
  state.fakes.delete(id);
}

function makeFake(name) {
  const fake = makeFakeWindow({
    name,
    onNavigate: (f, url) => handleFakeNavigate(f, url),
    onFocus: (f) => {
      const id = state.fakeIds.get(f);
      if (!id) return;
      // A hidden window's frame is gone but its handle stays live; focusing
      // it rebuilds the frame at the same ?w= (the launcher un-hides first).
      if (!wm.has(id) && f.location.href !== "about:blank") {
        handleFakeNavigate(f, f.location.href);
      } else {
        wm.focusFrame(id);
      }
    },
    onClose: (f) => {
      state.blanks.delete(f);
      const id = state.fakeIds.get(f);
      if (id) {
        wm.closeFrame(id, { silent: true });
        state.fakes.delete(id);
      }
    },
  });
  state.blanks.add(fake);
  return fake;
}

function handleFakeNavigate(fake, url) {
  let abs;
  try {
    abs = new URL(url, location.origin);
  } catch {
    return url;
  }
  if (abs.origin !== location.origin) {
    // External URL from a shimmed frame: hand it to a real browser window.
    window.open(abs.href, "_blank", "noopener,noreferrer");
    return abs.href;
  }
  const windowId = abs.searchParams.get("w") || fake.name || `anon-${++state.anonSeq}`;
  const previous = state.fakeIds.get(fake);
  if (previous && previous !== windowId) {
    wm.closeFrame(previous, { silent: true });
    state.fakes.delete(previous);
  }
  bindFake(fake, windowId);
  const record = state.records.get(windowId);
  // Opening a buried window un-buries it, the way the SPA's own focus flow
  // clears `hidden` before raising; otherwise the next feed snapshot would
  // reconcile the new frame straight back out.
  if (record && record.hidden) {
    apiPost(`/api/library/windows/${encodeURIComponent(windowId)}/visibility`, {
      hidden: false,
    }).catch((err) => notice(`show failed: ${err.message}`));
  }
  const framed = frameIdFor(windowId);
  if (framed) {
    // Re-navigation to a live frame (named reopen, or the deck's focus/bury
    // reaching for a window the watcher placed): focus instead of a pointless
    // SPA reload, and never a second frame onto the same session.
    wm.focusFrame(framed);
  } else {
    wm.createFrame({
      id: windowId,
      url: abs.href,
      title: record ? frameTitle(record) : abs.pathname.split("/")[1] || "chan",
      kind: record ? record.kind : abs.searchParams.get("kind") ? "terminal" : "workspace",
      managed: Boolean(record || abs.searchParams.get("w")),
    });
  }
  return abs.href;
}

function lookupNamed(name) {
  const byId = state.fakes.get(name);
  if (byId && !byId.closed) return byId;
  for (const blank of state.blanks) {
    if (blank.name === name && !blank.closed) return blank;
  }
  return null;
}

// The record behind a frame, when the shell has one. It always does for a frame
// it opened itself, and for a watcher frame of the local library; a frame of a
// connected devserver has none, because the shell watches only the library it
// is served by. The host owns those windows anyway, so the absence costs
// nothing but a title.
function recordFor(id) {
  return state.records.get(windowIdOf(id)) ?? null;
}

// The WinBox close button buries the window, chan-desktop style: flip the
// record's persisted visibility and let the feed drive the teardown, so the
// launcher row's eye brings it back at the same ?w=. The frame is hidden
// optimistically for an instant response (and so the SPA's terminal
// "hidden by the leader" overlay is never seen); a failed hide reveals it
// again. Frames with no window behind them really close and retire their handle.
function onFrameCloseRequested(id) {
  if (!recordFor(id) && !(state.hosted && isNativeLabel(id))) {
    wm.closeFrame(id, { silent: true });
    dropFake(id, { markClosed: true });
    return;
  }
  // chan-desktop decides before it asks: an empty window, or one behind the
  // reconnect overlay, closes and is discarded with no prompt.
  if (closeDecisionFor(id) === "discard") {
    discardWindow(id);
    return;
  }
  askClose(id);
}

function frameDocument(id) {
  const frame = wm.get(id);
  if (!frame) return null;
  try {
    return frame.iframe.contentDocument;
  } catch {
    return null; // cross-origin content: the shell cannot inspect it
  }
}

function closeDecisionFor(id) {
  const doc = frameDocument(id);
  if (!doc) return "prompt";
  return closeDecision(doc, recordFor(id)?.kind);
}

// Under a host the window watcher owns the teardown, so both outcomes go
// through it: the same authority a native window's red dot reaches, which is
// also the only place that can bury a devserver window or refuse a close mid
// transfer. The frame is left alone here; the watcher closes it.
function hostClose(id, { hide }) {
  host.requestClose(id, { hide }).catch((err) => {
    if (hide) wm.showFrame(id);
    notice(`${hide ? "hide" : "close"} failed: ${err.message ?? err}`);
  });
}

function buryWindow(id) {
  wm.hideFrame(id);
  if (state.hosted && isNativeLabel(id)) {
    hostClose(id, { hide: true });
    return;
  }
  apiPost(`/api/library/windows/${encodeURIComponent(windowIdOf(id))}/visibility`, {
    hidden: true,
  }).catch((err) => {
    wm.showFrame(id);
    notice(`hide failed: ${err.message}`);
  });
}

function discardWindow(id) {
  if (state.hosted && isNativeLabel(id)) {
    hostClose(id, { hide: false });
    return;
  }
  wm.closeFrame(id, { silent: true });
  dropFake(id, { markClosed: true });
  apiDelete(`/api/library/windows/${encodeURIComponent(windowIdOf(id))}`).catch((err) =>
    notice(`close failed: ${err.message}`),
  );
}

// Hide / Close / Cancel, the choice chan-desktop puts behind a window's OS
// close button. Rendered in the shell rather than evalled into the page: the
// windows here are chan's own SPA, which the shell does not modify.
function askClose(id) {
  const frame = wm.get(id);
  if (!frame) return;
  const record = recordFor(id);
  const prompt = els.closePrompt;
  prompt.innerHTML = "";
  prompt.hidden = false;

  const card = document.createElement("div");
  card.className = "close-card";
  const title = document.createElement("div");
  title.className = "close-title";
  // A devserver frame has no record here, but the host already gave the frame
  // its composed title.
  title.textContent = record ? frameTitle(record) : frame.title;
  const body = document.createElement("div");
  body.className = "close-body";
  body.textContent = "Hide keeps this window's session; close discards it.";
  const actions = document.createElement("div");
  actions.className = "close-actions";

  const dismiss = () => {
    prompt.hidden = true;
    prompt.innerHTML = "";
    document.removeEventListener("keydown", onKey, true);
  };
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    }
  }
  const button = (label, className, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = label;
    b.addEventListener("click", () => {
      dismiss();
      if (run) run();
    });
    return b;
  };
  actions.append(
    button("Cancel", "close-cancel"),
    button("Close", "close-discard", () => discardWindow(id)),
    button("Hide", "close-hide primary", () => buryWindow(id)),
  );
  card.append(title, body, actions);
  prompt.appendChild(card);

  // Anchor the card over its own window, the way the desktop prompt belongs
  // to the window it is asking about.
  const rect = frame.root.getBoundingClientRect();
  card.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
  card.style.top = `${Math.round(rect.top + Math.min(rect.height / 2, 220))}px`;

  document.addEventListener("keydown", onKey, true);
  card.querySelector(".close-hide").focus();
}

// The green dot zooms on click; hovering it offers the same choice macOS
// puts there, so fullscreen stays reachable without a second control.
let zoomMenuTimer = 0;
let zoomMenuFor = null;

function hideZoomMenu() {
  clearTimeout(zoomMenuTimer);
  zoomMenuFor = null;
  els.zoomMenu.hidden = true;
  els.zoomMenu.innerHTML = "";
}

function showZoomMenu(id, anchor) {
  if (zoomMenuFor === id && !els.zoomMenu.hidden) return;
  const frame = wm.get(id);
  if (!frame) return;
  zoomMenuFor = id;
  const menu = els.zoomMenu;
  menu.innerHTML = "";
  const item = (label, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      hideZoomMenu();
      run();
    });
    return b;
  };
  const maximized = wm.isMaximized(id);
  menu.append(
    item(maximized ? "Restore" : "Maximise", () =>
      maximized ? frame.wb.restore() : frame.wb.maximize(true),
    ),
    item("Fullscreen", () => frame.wb.fullscreen(true)),
  );
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left - 6)}px`;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
}

function onZoomHover(id, anchor) {
  clearTimeout(zoomMenuTimer);
  zoomMenuTimer = setTimeout(() => showZoomMenu(id, anchor), 420);
}

function onZoomLeave() {
  clearTimeout(zoomMenuTimer);
  zoomMenuTimer = setTimeout(() => {
    if (!els.zoomMenu.matches(":hover")) hideZoomMenu();
  }, 260);
}

// --------------------------------------------------------------- new window

async function openNewWindow(request) {
  const destination = getDestination();
  // Pre-open the OS popup synchronously so the user activation still grants
  // it (the same trick the SPA itself uses).
  const popup = destination === "os" ? window.open("", "_blank") : null;
  try {
    // No origin claim: a Hybrid window is managed by this window manager,
    // not a browser tab, so it mints as native (the server's default). That
    // is what it would be under chan-desktop, and it keeps the launcher's
    // browser-tab reaper, which only ever touches origin:"browser" rows,
    // from discarding a window it did not open.
    const record = await apiPost("/api/library/windows", {
      kind: request.kind,
      workspace_path: request.workspace_path,
      acting_window_id: request.acting_window_id,
    });
    state.records.set(record.window_id, record);
    const url = windowUrlFor(record, location.origin);
    if (destination === "os") {
      if (popup) {
        popup.location.href = url;
        popup.focus();
      } else {
        window.open(url, record.window_id);
      }
      return;
    }
    // Under a host the record is all this owes: the mint is native-origin, so
    // the window watcher sees it, applies the destination and pushes the frame
    // back. Opening one here too would leave the same window in two frames --
    // two views of one session, mirroring each other's input, because both
    // load the same `?w=`. The frames are keyed differently (the watcher by
    // native label, this path by bare window_id), so nothing dedupes them.
    if (state.hosted) return;
    const fake = makeFake(record.window_id);
    fake.location.href = url;
  } catch (err) {
    if (popup) popup.close();
    notice(`new window failed: ${err.message}`);
  }
}

function chordHandler(frameId) {
  return (event) => {
    if (isCycleChord(event)) {
      const ids = wm.list().map((frame) => frame.id);
      const target = nextFrameId(ids, frameId ?? wm.focusedId(), event.shiftKey);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      wm.focusFrame(target);
      return;
    }
    // Close-tab on a window with nothing left in it: chan closes the last
    // empty pane and the window with it, but the SPA leaves that last step to
    // the host, so the shell takes it. Any other case falls through
    // untouched, which is what keeps Ctrl+D reaching a shell as EOF.
    if (frameId && isCloseTabChord(event)) {
      const doc = frameDocument(frameId);
      if (doc && closesWindowOnCloseTab(doc, recordFor(frameId)?.kind)) {
        event.preventDefault();
        event.stopPropagation();
        discardWindow(frameId);
      }
      return;
    }
    if (!isNewWindowChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const record = frameId ? recordFor(frameId) : null;
    openNewWindow(newWindowRequest(frameId ? "frame" : "launcher", record, state.leaders));
  };
}

// -------------------------------------------------------------- frame wiring

function installIntoFrame(frameWindow, { frameId = null, isLauncher = false }) {
  let doc;
  try {
    doc = frameWindow.document;
  } catch {
    return; // cross-origin content: leave it alone
  }
  const realOpen = frameWindow.open.bind(frameWindow);
  frameWindow.open = createOpenShim({
    destination: getDestination,
    realOpen,
    lookupNamed,
    makeFake,
  });
  doc.addEventListener("keydown", chordHandler(frameId), true);
  if (isLauncher) {
    injectDestinationSwitch(doc);
    return;
  }
  // A pointer anywhere in a window's frame raises it. The launcher is the dock,
  // not a window, so it has no frame to raise.
  {
    doc.addEventListener(
      "pointerdown",
      () => {
        if (frameId) wm.focusFrame(frameId);
      },
      true,
    );
  }
}

// ---------------------------------------------------------------- watch feed

function applyWindowSet(set) {
  state.records = new Map((set.windows || []).map((r) => [r.window_id, r]));
  state.leaders = set.leaders || {};
  // A frame minted through the deck's capability launch has no ?w= in its
  // URL, so it starts unmanaged; promote it once its record shows up.
  for (const frame of wm.list()) {
    if (!frame.managed && state.records.has(frame.id)) frame.managed = true;
  }
  // Under a host the window watcher is the reconciler, and it has a wider view
  // than this feed does (every connected devserver, not just the library that
  // serves this page). Reconciling here as well would fight it: this feed knows
  // nothing about a devserver frame and would read it as a window to discard.
  // The records are still worth keeping for the leader claim below.
  if (state.hosted) return;
  const adopt = !state.restored;
  state.restored = true;
  const plan = reconcileFrames(wm.list(), state.records, Date.now(), {
    owned: new Set(state.fakes.keys()),
    adopt,
  });
  for (const id of plan.discard) {
    wm.closeFrame(id, { silent: true });
    dropFake(id, { markClosed: true });
  }
  // Bury keeps the handle: it is what tells this shell the window is still
  // ours to revive, and what keeps the launcher from reaping a record it
  // opened (it discards browser-origin rows whose handle reports closed).
  for (const id of plan.bury) wm.closeFrame(id, { silent: true });
  for (const record of plan.build) openFrameForRecord(record);
  for (const { id, title } of plan.retitle) wm.setTitle(id, title);
}

// Build (or rebuild) the frame for a record at its stable ?w=, reusing the
// window's existing handle when this shell already owns it.
function openFrameForRecord(record) {
  const fake = state.fakes.get(record.window_id) || makeFake(record.window_id);
  fake.closed = false;
  bindFake(fake, record.window_id);
  fake.location.href = windowUrlFor(record, location.origin);
}

function connectFeed(attempt = 0) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = encodeURIComponent(state.boot.token || "");
  const ws = new WebSocket(`${proto}://${location.host}/api/library/windows/watch?t=${token}`);
  let opened = false;
  ws.onopen = () => {
    opened = true;
  };
  ws.onmessage = (event) => {
    try {
      applyWindowSet(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames; the next push resyncs.
    }
  };
  ws.onclose = () => {
    const next = opened ? 0 : attempt + 1;
    setTimeout(() => connectFeed(next), watchBackoff(next));
  };
}

// --------------------------------------------------------------------- theme

// chan themes off its own persisted choice (the launcher stamps data-theme on
// its documentElement from config + localStorage), not off the OS appearance.
// Mirror the docked launcher's attribute so the WM chrome always agrees with
// the windows it hosts; prefers-color-scheme only seeds the pre-mirror paint.
function applyShellTheme(value) {
  document.documentElement.setAttribute(
    "data-theme",
    value === "light" ? "light" : "dark",
  );
}

let themeObserver = null;
function followLauncherTheme() {
  try {
    const root = els.launcher.contentDocument.documentElement;
    applyShellTheme(root.getAttribute("data-theme"));
    if (themeObserver) themeObserver.disconnect();
    themeObserver = new MutationObserver(() =>
      applyShellTheme(root.getAttribute("data-theme")),
    );
    themeObserver.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  } catch {
    // Cross-origin or not yet loaded: keep the seeded theme.
  }
}

// ------------------------------------------------------------------- collapse

// Which side of the seam is collapsed: "dock", "desktop", or "none". One value
// rather than a flag each, so collapsing both -- a window with nothing in it --
// is not a state that can be reached.
function collapsed() {
  return normalizeCollapse(localStorage.getItem(COLLAPSE_KEY));
}

function setCollapsed(next) {
  localStorage.setItem(COLLAPSE_KEY, normalizeCollapse(next));
  applyCollapse();
}

// Each control keeps a fixed arrow pointing at the pane it governs -- the
// launcher on the left, the windows on the right -- and carries its hidden/shown
// state as a pressed toggle instead. Flipping the arrow instead would make the
// two buttons render identically whenever either side is collapsed.
function applyCollapse() {
  const side = collapsed();
  document.body.classList.toggle("collapsed-dock", side === "dock");
  document.body.classList.toggle("collapsed-desktop", side === "desktop");
  const sync = (button, mine, label) => {
    const hidden = side === mine;
    button.classList.toggle("on", hidden);
    button.setAttribute("aria-pressed", String(hidden));
    button.title = hidden ? `Show ${label}` : `Hide ${label}`;
    button.setAttribute("aria-label", button.title);
  };
  sync(els.dockToggle, "dock", "launcher");
  sync(els.desktopToggle, "desktop", "windows");
  if (wm) wm.applyOffsets();
}

// The area a window may occupy. The desktop starts at the top of the window now
// that the shell has no chrome above it; the left edge clears the dock, or just
// the collapse rail when the dock is hidden.
function currentOffsets() {
  return {
    top: 0,
    left: collapsed() === "dock" ? 16 : els.dock.offsetWidth,
  };
}

// ---------------------------------------------------------------------- boot

function showError(text) {
  els.error.hidden = false;
  els.error.textContent = text;
}

// The launcher bearer arrives as `?t=` on the host window's URL, the same way
// the launcher window itself is opened. It is stripped from the address bar and
// kept in sessionStorage so a reload of the host stays authorized; the launcher
// frame keeps its own copy in its query string, which is how the SPA has always
// carried it.
function resolveToken() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("t");
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // A storage denial only costs the token across a reload.
    }
    history.replaceState(null, "", location.pathname);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

async function boot() {
  applyShellTheme(
    window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark",
  );
  state.boot = { token: resolveToken() };
  if (!state.boot.token) {
    showError(
      "Not authorized. This page needs the launcher token chan-desktop opens it with; reopen the Hybrid window from the app.",
    );
    return;
  }
  state.hosted = host.hasHost();

  wm = createWinboxWm({
    winbox: window.WinBox,
    storage: localStorage,
    offsets: currentOffsets,
    onCloseRequested: onFrameCloseRequested,
    onZoomHover,
    onZoomLeave,
    onFocused: (id) => {
      // The New Window chord is a native menu accelerator under a host, so the
      // resolver on that side needs to know which frame it would act on.
      if (state.hosted) host.reportFocus(isNativeLabel(id) ? id : null);
    },
    onFrameReady: (id, iframe) => {
      installIntoFrame(iframe.contentWindow, { frameId: id });
    },
    onFramesChanged: reportFrames,
  });

  if (state.hosted) {
    await host.subscribe({
      onOpen: ({ label, url, title, kind }) => {
        // The watcher may push an open for a window that already has a frame
        // (a rebuild after a workspace came back on); createFrame focuses in
        // that case rather than stacking a second one.
        wm.createFrame({ id: label, url, title, kind, managed: true });
      },
      onClose: (label) => wm.closeFrame(label, { silent: true }),
      onRetitle: (label, title) => wm.setTitle(label, title),
      // The launcher row's Open, `cs window`, and the Window menu all land
      // here: the host has already raised itself, and this brings the frame
      // forward inside it.
      onFocus: (label) => wm.focusFrame(label),
    });
    // The watcher's first reconcile may already have run and been answered
    // with an empty set, so say so explicitly rather than waiting for a frame
    // change that will not come. The answer carries the authoritative
    // destination, which is what the switch renders from here on.
    adoptHostDestination(await reportFrames());
  }

  els.zoomMenu.addEventListener("mouseleave", hideZoomMenu);

  els.dockToggle.addEventListener("click", () =>
    setCollapsed(toggleCollapse(collapsed(), "dock")),
  );
  els.desktopToggle.addEventListener("click", () =>
    setCollapsed(toggleCollapse(collapsed(), "desktop")),
  );
  applyCollapse();

  // The launcher keeps its ?t= in the query string (it reads it per call and
  // never strips it), so reloads inside the iframe stay authorized.
  els.launcher.addEventListener("load", () => {
    installIntoFrame(els.launcher.contentWindow, { isLauncher: true });
    followLauncherTheme();
  });
  els.launcher.src = state.boot.token ? `/?t=${encodeURIComponent(state.boot.token)}` : "/";

  // Debug/e2e handle; the page is loopback-only and already holds the token.
  window.__hybrid = { wm, state, getDestination, setDestination };

  document.addEventListener("keydown", chordHandler(null), true);
  // A stray drop on the shell's own chrome must not navigate the whole page,
  // which would take every window down with it. The SPA's own guard covers
  // only its own documents, so the shell guards its own.
  //
  // Scoped to the chrome, never to a frame. WebKit surfaces a drag that is
  // over a subframe to the parent as well, with the `<iframe>` as the target;
  // claiming those made the shell swallow every drop bound for a window, so a
  // tab could be picked up but never put down. Chrome does not surface them,
  // which is why this only ever showed up in the desktop's WKWebView.
  const overFrame = (event) =>
    event.target instanceof Element && event.target.closest("iframe") !== null;
  window.addEventListener("dragover", (e) => {
    if (!overFrame(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!overFrame(e)) e.preventDefault();
  });
  window.addEventListener("resize", () => wm.applyOffsets());

  connectFeed();
}

boot();
