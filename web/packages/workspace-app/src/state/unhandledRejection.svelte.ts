// A rejected promise nobody handled reaches the console and nothing else,
// so a failed action can look like one that did nothing. Route the reason
// through the same status bus the leaf state modules use.

import { notify } from "./notify.svelte";

export function describeRejection(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Install the window listener. The entry point calls this before mounting,
 *  so a rejection raised while mounting is surfaced too. */
export function installUnhandledRejectionNotice(): () => void {
  const onRejection = (event: PromiseRejectionEvent): void => {
    notify(`Unhandled error: ${describeRejection(event.reason)}`);
  };
  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}
