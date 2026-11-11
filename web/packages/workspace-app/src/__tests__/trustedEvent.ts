// Dispatch an event as the engine's own, for handlers that key on
// `isTrusted`. jsdom keeps `isTrusted` unforgeable on the event and
// `dispatchEvent` resets it, as a browser does, so the helper sets it on
// jsdom's implementation of the event and dispatches through the target's
// implementation, the way jsdom fires the events it raises itself.

export function dispatchTrusted(target: EventTarget, event: Event): boolean {
  const eventImpl = jsdomImpl<{ isTrusted: boolean }>(event);
  eventImpl.isTrusted = true;
  const dispatched = jsdomImpl<{ _dispatch(event: unknown): boolean }>(target)._dispatch(eventImpl);
  if (!event.isTrusted) throw new Error("the event did not stay trusted through its dispatch");
  return dispatched;
}

function jsdomImpl<T>(wrapper: object): T {
  const symbol = Object.getOwnPropertySymbols(wrapper).find((s) => s.description === "impl");
  if (!symbol) throw new Error("jsdom's implementation object was not found");
  return (wrapper as Record<symbol, T>)[symbol];
}
