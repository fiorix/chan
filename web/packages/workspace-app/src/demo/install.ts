// Install the in-memory backend the workspace app's component tests mount the
// real App against: point the transport's fetch, WebSocket and XHR factories
// at the mock. Call before the app mounts; the real transport is unchanged
// until this runs. uninstallDemoWorkspace, in the test's teardown, restores
// the real socket and XHR factories but not the real fetch: a request after
// it is a leak, and fails as one.

import { setFetchImpl, setSocketFactory, setXhrFactory } from "../api/transport";
import type { Preferences } from "../api/types";
import type { MockWorkspaceData } from "./data";
import { DemoGraph } from "./graph";
import { MockReports } from "./report";
import { createDemoFetch } from "./router";
import { demoSocketFactory } from "./socket";
import { MockWorkspaceStore } from "./store";
import { createDemoUploadXhr } from "./upload";

/// A request that reached the transport after the demo workspace was
/// uninstalled. Something the mounted app armed (a bootstrap step, a poll, a
/// debounce) outlived the test's teardown. Without this it would reach Node's
/// own fetch, whose relative-URL rejection names neither the demo transport
/// nor the leak.
export class DemoTransportUninstalledError extends Error {
  constructor(readonly url: string) {
    super(`${url} was requested after uninstallDemoWorkspace; a timer or continuation outlived its test`);
    this.name = "DemoTransportUninstalledError";
  }
}

/// Requests the installed demo fetch has accepted and not yet answered.
let inFlight = 0;

export function installDemoWorkspace(
  data: MockWorkspaceData,
  opts: { preferences?: Partial<Preferences> } = {},
): MockWorkspaceStore {
  const store = new MockWorkspaceStore(data);
  const reportRows = data.reports?.files ?? [];
  const graph = new DemoGraph(store, reportRows);
  const reports = new MockReports(reportRows);
  const demoFetch = createDemoFetch(store, graph, reports, opts.preferences);
  inFlight = 0;
  setFetchImpl(async (input, init) => {
    inFlight += 1;
    try {
      return await demoFetch(input, init);
    } finally {
      inFlight -= 1;
    }
  });
  setSocketFactory(demoSocketFactory);
  setXhrFactory(() => createDemoUploadXhr(store, graph));
  return store;
}

/// Resolve once the demo transport has had no request in flight for
/// `quietTurns` consecutive macrotasks, which is when a mounted app's
/// bootstrap has settled: its steps chain through awaited requests and
/// zero-delay timers (the mock socket opens on one), never through a longer
/// wait against a mock that answers at once. Rejects after `timeoutMs`, so a
/// chain that never settles fails the teardown that waits for it. Call with
/// real timers installed.
export async function demoTransportSettled(quietTurns = 3, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (quiet < quietTurns) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    quiet = inFlight === 0 ? quiet + 1 : 0;
    if (quiet < quietTurns && Date.now() > deadline) {
      throw new Error(`the demo transport still had ${inFlight} request(s) in flight after ${timeoutMs} ms`);
    }
  }
}

export function uninstallDemoWorkspace(): void {
  setFetchImpl(async (input) => {
    throw new DemoTransportUninstalledError(input);
  });
  setSocketFactory(null);
  setXhrFactory(null);
}
