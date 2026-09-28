// Tiny status-message bus. Lets leaf state modules (tabs.svelte.ts,
// editor extensions) surface a transient status string without taking
// a hard import on the store, which would create a cycle.
//
// At app boot, `store.svelte.ts` registers a handler that maps notify()
// calls to `ui.status`. Modules that import store can set ui.status
// directly; this bus is for the ones below it.

let handler: ((msg: string) => void) | null = null;

export function setNotifyHandler(fn: (msg: string) => void): void {
  handler = fn;
}

export function notify(msg: string): void {
  if (handler) handler(msg);
  else console.warn(msg);
}

let statusReader: (() => string | null) | null = null;

/// The store registers what the status bar shows, beside the handler above
/// and for the same reason: a leaf module that must know whether a status of
/// its own still shows cannot import the store.
export function setStatusReader(fn: () => string | null): void {
  statusReader = fn;
}

/// Whether the status bar shows `msg` now.
export function statusShows(msg: string): boolean {
  return statusReader?.() === msg;
}
