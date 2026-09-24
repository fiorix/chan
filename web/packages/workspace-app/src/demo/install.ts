// Install the in-memory backend the workspace app's component tests mount the
// real App against: point the transport's fetch, WebSocket and XHR factories
// at the mock. Call before the app mounts; the real transport is unchanged
// until this runs, and uninstallDemoWorkspace restores it in the test's
// teardown.

import { setFetchImpl, setSocketFactory, setXhrFactory } from "../api/transport";
import type { Preferences } from "../api/types";
import type { MockWorkspaceData } from "./data";
import { DemoGraph } from "./graph";
import { MockReports } from "./report";
import { createDemoFetch } from "./router";
import { demoSocketFactory } from "./socket";
import { MockWorkspaceStore } from "./store";
import { createDemoUploadXhr } from "./upload";

export function installDemoWorkspace(
  data: MockWorkspaceData,
  opts: { preferences?: Partial<Preferences> } = {},
): MockWorkspaceStore {
  const store = new MockWorkspaceStore(data);
  const reportRows = data.reports?.files ?? [];
  const graph = new DemoGraph(store, reportRows);
  const reports = new MockReports(reportRows);
  setFetchImpl(createDemoFetch(store, graph, reports, opts.preferences));
  setSocketFactory(demoSocketFactory);
  setXhrFactory(() => createDemoUploadXhr(store, graph));
  return store;
}

export function uninstallDemoWorkspace(): void {
  setFetchImpl(null);
  setSocketFactory(null);
  setXhrFactory(null);
}
