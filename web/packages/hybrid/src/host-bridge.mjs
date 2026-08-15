// The shell's half of the chan-desktop contract.
//
// The Hybrid shell runs on two surfaces. Under chan-desktop it is the main
// frame of a Tauri webview, so `__TAURI_INTERNALS__` is there and the window
// watcher drives it: the watcher decides a window should exist and pushes an
// open, and the shell answers with the set of frames it holds so the watcher's
// reconcile can account for windows that have no OS window to enumerate.
// Served from a plain browser (a devserver, or the shell opened in a tab) there
// is no bridge, every call here is inert, and the shell falls back to being its
// own authority through the library's HTTP API.
//
// Tauri injects its IPC into the MAIN FRAME ONLY, which is the fact the whole
// design rests on: the shell has a bridge, and the chan windows it hosts in
// iframes do not, so those SPAs take their browser paths and the shell's
// `window.open` shim is what catches their window flows.

const EVENT_OPEN = "hybrid://open";
const EVENT_CLOSE = "hybrid://close";
const EVENT_RETITLE = "hybrid://retitle";
const EVENT_FOCUS = "hybrid://focus";

function internals() {
  return typeof window === "undefined" ? null : (window.__TAURI_INTERNALS__ ?? null);
}

/** Whether chan-desktop is hosting this page. */
export function hasHost() {
  return Boolean(internals()?.invoke);
}

async function invoke(command, args) {
  const bridge = internals();
  if (!bridge?.invoke) return null;
  return bridge.invoke(command, args);
}

/** Subscribe to a host event. Resolves to an unlisten function, or null with no
 * host. Uses the event plugin directly rather than the `@tauri-apps/api`
 * package, so the shell keeps its zero-dependency build. */
async function listen(event, handler) {
  const bridge = internals();
  if (!bridge?.invoke) return null;
  const id = await bridge.invoke("plugin:event|listen", {
    event,
    target: { kind: "Any" },
    handler: bridge.transformCallback((message) => handler(message.payload)),
  });
  return () =>
    bridge.invoke("plugin:event|unlisten", { event, eventId: id }).catch(() => {});
}

/** Wire the watcher's pushes to the shell's frame operations.
 *
 * `onOpen` receives `{label, url, title, kind}`; the label is the native
 * `{library_id}::{window_id}`, which is the shell's frame key on this surface.
 */
export async function subscribe({ onOpen, onClose, onRetitle, onFocus }) {
  const unlisten = await Promise.all([
    listen(EVENT_OPEN, (payload) => payload && onOpen(payload)),
    listen(EVENT_CLOSE, (label) => label && onClose(label)),
    listen(EVENT_RETITLE, (payload) => payload && onRetitle(payload.label, payload.title)),
    listen(EVENT_FOCUS, (label) => label && onFocus(label)),
  ]);
  return () => unlisten.forEach((off) => off && off());
}

/** Report the frames the shell holds, and read back the host's destination.
 *
 * The report IS `open_labels` for the Hybrid surface, so it must be sent on
 * every change: a stale set makes the watcher either open a duplicate or leave
 * a dead frame behind. The whole set is sent rather than a delta so a dropped
 * message self-heals on the next one.
 *
 * The answer is the authoritative destination. The shell holds its own copy for
 * the surface with no host, and the two defaults differ, so the first call is
 * what stops the switch from describing a placement the watcher is not making.
 * Resolves null when there is no host, or when the call fails. */
export function reportFrames(labels) {
  const call = invoke("hybrid_frames", { labels });
  if (!call) return Promise.resolve(null);
  return call.catch(() => null);
}

/** Report which frame has focus, so the New Window chord can answer for a
 * window the OS window manager cannot see. */
export function reportFocus(label) {
  return invoke("hybrid_focus", { label: label ?? null })?.catch(() => {});
}

/** Ask the host to bury or discard a window, after the shell has asked the
 * user. Rejects when the window has a transfer in flight, which is the one
 * close guard the shell cannot see for itself. */
export function requestClose(label, { hide }) {
  return invoke("hybrid_close_requested", { label, hide: Boolean(hide) });
}

/** Persist the destination switch. */
export function setDestination(destination) {
  return invoke("hybrid_set_destination", { destination })?.catch(() => {});
}
