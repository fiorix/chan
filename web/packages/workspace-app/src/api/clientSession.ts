import { holderTagOf, openerHolderTag } from "@chan/web-shared/window-holder";

let fallback: string | null = null;
let detached = false;
const listeners = new Set<() => void>();

/** One desktop process or browser opener keeps the same claim across its windows.
 * A directly navigated browser tab retains its own claim across reloads. */
export function clientHolder(): string {
  const tag = holderTagOf(window.location.href);
  if (tag) return tag;
  if (fallback) return fallback;
  try {
    fallback = sessionStorage.getItem("chan-client-holder");
    if (!fallback || !/^[A-Za-z0-9_-]{1,64}$/.test(fallback)) {
      fallback = openerHolderTag();
      sessionStorage.setItem("chan-client-holder", fallback);
    }
  } catch {
    fallback = openerHolderTag();
  }
  return fallback;
}

export function clientDetached(): boolean { return detached; }

export function markClientDetached(): void {
  if (detached) return;
  detached = true;
  for (const listener of listeners) listener();
}

export function onClientDetached(listener: () => void): () => void {
  listeners.add(listener);
  if (detached) listener();
  return () => listeners.delete(listener);
}
