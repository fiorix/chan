// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?kind=terminal&w=w-name&h=desktop-name");
});
afterEach(async () => {
  const store = await import("./store.svelte");
  store.dismissStatus();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test.each([undefined, null, 42, {}])("a receipt with no string error keeps the status untouched: %j", async (name_error) => {
  const store = await import("./store.svelte");
  const { clientSession } = await import("./clientSession.svelte");
  store.dismissStatus();
  store.onWatchEvent({ type: "session_client", id: "c-self", name_error });
  expect(clientSession.id).toBe("c-self");
  expect(store.ui.status).toBeNull();
});

test("a refused client name shows the exact sentence and keeps the client receipt", async () => {
  const store = await import("./store.svelte");
  const { clientSession } = await import("./clientSession.svelte");
  store.dismissStatus();
  const error = "session name is already held by client c-other";
  store.onWatchEvent({ type: "session_client", id: "c-self", name_error: error });
  expect(clientSession.id).toBe("c-self");
  expect(store.ui.status).toBe(error);
  expect(store.ui.statusKind).toBe("transient");
  expect(clientSession.detached).toBe(false);
  store.dismissStatus();
});
