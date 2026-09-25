// The teardown for a test that mounted the app over the demo transport. The
// app arms timers and continuations that unmounting does not stop, so the
// order matters: let the bootstrap settle against the demo backend, unmount,
// stop the index poll (it refuses to re-arm while its handle is set), release
// the timers the test tracked, uninstall the demo, and reset the URL hash and
// sessionStorage the next mount's bootstrap would restore a layout from.

import { unmount } from "svelte";

import { stopIndexStatusPoller } from "../state/store.svelte";
import { demoTransportSettled, uninstallDemoWorkspace } from "./install";
import type { TimerTrack } from "./timers";

export interface DemoAppTeardown {
  /// The apps the test mounted; emptied here.
  mounted: Array<Record<string, unknown>>;
  /// The test's timer track, released here.
  timers: TimerTrack | null;
  /// The wait before unmounting. Defaults to the demo transport's settle; a
  /// test of this teardown passes one that rejects.
  settle?: () => Promise<void>;
}

/// Run the teardown. Call it with real timers installed.
export async function teardownDemoApp({
  mounted,
  timers,
  settle = demoTransportSettled,
}: DemoAppTeardown): Promise<void> {
  await settle();
  for (const app of mounted.splice(0)) unmount(app);
  stopIndexStatusPoller();
  timers?.release();
  uninstallDemoWorkspace();
  history.replaceState(null, "", window.location.pathname + window.location.search);
  sessionStorage.clear();
}
