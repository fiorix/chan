// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as client from "../api/client";
import { api } from "../api/client";
import { updateGlobalConfigSerial } from "../api/preferenceWrite";
import { setFetchImpl } from "../api/transport";
import { resetShownPreferencesForTests, shownPreferences, writePreferences } from "../components/settings/preferenceState.svelte";
import { DemoGraph } from "../demo/graph";
import { MockReports } from "../demo/report";
import { createDemoFetch } from "../demo/router";
import { MockWorkspaceStore } from "../demo/store";
import { pageWidth, setPageWidth } from "./pageWidth.svelte";
import {
  bootstrap,
  browserSidePanes,
  currentPreferences,
  onWatchEvent,
  paneWidths,
  persistPaneWidths,
  refreshWorkspace,
  setBrowserSidePane,
  setThemeChoice,
  stopWorkspaceRefresh,
  teardown,
  ui,
  workspace,
} from "./store.svelte";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function heldRequest() {
  const started = deferred();
  const released = deferred();
  releases.push(released.resolve);
  return { started, released };
}

let heldWorkspace: ReturnType<typeof heldRequest> | null;
let heldPatch: ReturnType<typeof heldRequest> | null;
let releases: Array<() => void>;
let operations: Array<Promise<unknown>>;
let patchResponses: Array<ReturnType<typeof deferred>>;
let patchCount: number;
let workspaceReads: number;
let demoStore: MockWorkspaceStore;

function patchResponse(index: number): ReturnType<typeof deferred> {
  return patchResponses[index] ??= deferred();
}

function startRefresh(): Promise<void> {
  const operation = refreshWorkspace();
  operations.push(operation);
  return operation;
}

function stubWatch() {
  return vi.spyOn(client, "openWatchSocket").mockImplementation(() => Object.assign(() => {}, {
    subscribeDir() {},
    unsubscribeDir() {},
    reportTransfers() {},
    probe() {},
    close() {},
  }));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resetShownPreferencesForTests();
  heldWorkspace = null;
  heldPatch = null;
  releases = [];
  operations = [];
  patchResponses = [];
  patchCount = 0;
  workspaceReads = 0;
  demoStore = new MockWorkspaceStore({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 1, textCount: 1 },
    files: [{ path: "note.md", kind: "text", size: 5, mtime: 1, content: "hello" }],
  });
  const demoFetch = createDemoFetch(demoStore, new DemoGraph(demoStore), new MockReports([]), {
    theme: "light",
    browser_side_panes: { left: false, right: false },
    date_format: "iso",
  });
  setFetchImpl(async (input, init) => {
    const path = new URL(input, "http://demo.local").pathname;
    if (path === "/api/workspace") workspaceReads += 1;
    if (path === "/api/workspace" && heldWorkspace) {
      const hold = heldWorkspace;
      heldWorkspace = null;
      // Capture the real routed response before the local write changes it.
      const response = await demoFetch(input, init);
      hold.started.resolve();
      await hold.released.promise;
      return response;
    }
    if (path === "/api/config" && init?.method === "PATCH" && heldPatch) {
      const hold = heldPatch;
      heldPatch = null;
      hold.started.resolve();
      await hold.released.promise;
    }
    const response = await demoFetch(input, init);
    if (path === "/api/config" && init?.method === "PATCH") {
      patchResponse(patchCount++).resolve();
    }
    return response;
  });
  await refreshWorkspace();
});

afterEach(async () => {
  for (const release of releases) release();
  // A failed drag assertion can leave readers waiting for a debounce.
  await vi.advanceTimersByTimeAsync(500);
  await Promise.allSettled(operations);
  // Dock setters intentionally return void; drain the public write queue.
  await updateGlobalConfigSerial(() => null);
  await vi.advanceTimersByTimeAsync(250);
  teardown();
  resetShownPreferencesForTests();
  workspace.info = null;
  setFetchImpl(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workspace reads overlapping local preference writes", () => {
  test("an older response cannot revert a pane-width drag before its debounce enqueues", async () => {
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;
    expect(paneWidths.graph).not.toBe(444);

    paneWidths.graph = 444;
    persistPaneWidths();
    expect(patchCount).toBe(0);
    read.released.resolve();
    await refreshing;
    expect.soft(paneWidths.graph).toBe(444);

    await vi.advanceTimersByTimeAsync(199);
    expect(patchCount).toBe(0);
    await vi.advanceTimersByTimeAsync(301);
    expect.soft((await api.config()).preferences.pane_widths.graph).toBe(444);
    expect.soft(paneWidths.graph).toBe(444);
    expect.soft(currentPreferences()?.pane_widths.graph).toBe(444);
  });

  test("an older response cannot revert a page-width drag before its debounce enqueues", async () => {
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;
    expect(pageWidth.ratio).not.toBe(0.55);

    setPageWidth(0.55);
    expect(patchCount).toBe(0);
    read.released.resolve();
    await refreshing;
    expect.soft(pageWidth.ratio).toBe(0.55);

    // An invalidated read retries before this drag's longer debounce fires.
    await vi.advanceTimersByTimeAsync(250);
    expect(patchCount).toBe(0);
    expect.soft(pageWidth.ratio).toBe(0.55);
    await vi.advanceTimersByTimeAsync(400);
    expect.soft((await api.config()).preferences.page_width_ratio).toBe(0.55);
    expect.soft(pageWidth.ratio).toBe(0.55);
    expect.soft(currentPreferences()?.page_width_ratio).toBe(0.55);
  });

  test("a workspace read begun during a page-width debounce waits for the drag's write", async () => {
    setPageWidth(0.55);
    const refreshing = startRefresh();
    await vi.advanceTimersByTimeAsync(250);

    expect(patchCount).toBe(0);
    expect.soft(pageWidth.ratio).toBe(0.55);
    await vi.advanceTimersByTimeAsync(400);
    await refreshing;
    expect.soft((await api.config()).preferences.page_width_ratio).toBe(0.55);
    expect.soft(pageWidth.ratio).toBe(0.55);
    expect.soft(currentPreferences()?.page_width_ratio).toBe(0.55);
  });

  test("rearming a page-width debounce keeps a waiting read behind the latest drag tick", async () => {
    const readsBeforeDrag = workspaceReads;
    setPageWidth(0.55);
    const refreshing = startRefresh();
    await vi.advanceTimersByTimeAsync(200);
    expect(workspaceReads).toBe(readsBeforeDrag);

    setPageWidth(0.65);
    await vi.advanceTimersByTimeAsync(200);
    expect.soft(workspaceReads).toBe(readsBeforeDrag);
    expect.soft(pageWidth.ratio).toBe(0.65);
    expect(patchCount).toBe(0);
    await vi.advanceTimersByTimeAsync(199);
    expect.soft(workspaceReads).toBe(readsBeforeDrag);
    expect(patchCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await refreshing;
    expect(patchCount).toBe(1);
    expect((await api.config()).preferences.page_width_ratio).toBe(0.65);
    expect(currentPreferences()?.page_width_ratio).toBe(0.65);
    expect(pageWidth.ratio).toBe(0.65);
  });

  test("overlapping width drags delay reads while unrelated immediate writes still progress", async () => {
    const readsBeforeDrag = workspaceReads;
    paneWidths.graph = 444;
    persistPaneWidths();
    setPageWidth(0.55);
    const refreshing = startRefresh();
    const themeWrite = setThemeChoice("dark");
    operations.push(themeWrite);
    await themeWrite;
    expect((await api.config()).preferences.theme).toBe("dark");
    expect(workspaceReads).toBe(readsBeforeDrag);

    await vi.advanceTimersByTimeAsync(200);
    const halfway = (await api.config()).preferences;
    expect(halfway.pane_widths.graph).toBe(444);
    expect(halfway.page_width_ratio).not.toBe(0.55);
    expect.soft(workspaceReads).toBe(readsBeforeDrag);
    expect.soft(pageWidth.ratio).toBe(0.55);

    await vi.advanceTimersByTimeAsync(200);
    await refreshing;
    expect(patchCount).toBe(3);
    expect(currentPreferences()).toMatchObject({
      theme: "dark", page_width_ratio: 0.55, pane_widths: { graph: 444 },
    });
    expect(ui.themeChoice).toBe("dark");
    expect(pageWidth.ratio).toBe(0.55);
    expect(paneWidths.graph).toBe(444);
  });

  test("stopping a read waiting for a width debounce prevents its eventual workspace request", async () => {
    const beforeStop = workspace.info;
    demoStore.data.metadata.label = "After stop";
    setPageWidth(0.55);
    const refreshing = startRefresh();
    await vi.advanceTimersByTimeAsync(0);
    stopWorkspaceRefresh();
    const readsAtStop = workspaceReads;

    await vi.advanceTimersByTimeAsync(400);
    await refreshing;
    await vi.advanceTimersByTimeAsync(300);
    expect((await api.config()).preferences.page_width_ratio).toBe(0.55);
    expect(pageWidth.ratio).toBe(0.55);
    expect(workspace.info).toBe(beforeStop);
    expect(workspaceReads).toBe(readsAtStop);
  });

  test.each(["pane", "page"] as const)(
    "teardown releases a pending %s-width edit so the next workspace can load",
    async (kind) => {
      const armWidthEdit = () => {
        if (kind === "pane") {
          paneWidths.graph = 444;
          persistPaneWidths();
        } else {
          setPageWidth(0.55);
        }
      };
      const readsBeforeDrag = workspaceReads;
      let canceledReadSettled = false;
      let nextReadSettled = false;
      armWidthEdit();
      void startRefresh().then(() => { canceledReadSettled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaceReads).toBe(readsBeforeDrag);

      try {
        teardown();
        expect.soft(vi.getTimerCount()).toBe(0);
        // The mounted-app timer tracker clears canceled work without firing
        // its callback; the owner must also release its pending edit.
        vi.clearAllTimers();
        void startRefresh().then(() => { nextReadSettled = true; });
        await vi.advanceTimersByTimeAsync(0);

        expect.soft(canceledReadSettled).toBe(true);
        expect.soft(nextReadSettled).toBe(true);
        expect.soft(workspaceReads).toBe(readsBeforeDrag + 1);
        expect.soft(patchCount).toBe(0);
      } finally {
        // Rearming releases an orphaned intent on failing code, so this
        // regression cannot strand the other tests' workspace reads.
        armWidthEdit();
        await vi.advanceTimersByTimeAsync(500);
        await Promise.allSettled(operations);
      }
    },
  );

  test("a no-op width debounce releases a waiting read without a config_changed frame", async () => {
    const currentRatio = (await api.config()).preferences.page_width_ratio;
    if (currentRatio === undefined) throw new Error("demo fixture has no page-width ratio");
    const readsBeforeDrag = workspaceReads;
    setPageWidth(currentRatio);
    const refreshing = startRefresh();
    await vi.advanceTimersByTimeAsync(399);
    expect(workspaceReads).toBe(readsBeforeDrag);

    await vi.advanceTimersByTimeAsync(1);
    await refreshing;
    expect(patchCount).toBe(0);
    expect(workspaceReads).toBe(readsBeforeDrag + 1);
    expect(currentPreferences()?.page_width_ratio).toBe(currentRatio);
    expect(pageWidth.ratio).toBe(currentRatio);
  });

  test("an older workspace response cannot close a dock the user just opened", async () => {
    demoStore.data.metadata.label = "Updated workspace label";
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;

    setBrowserSidePane("left", true);
    await patchResponse(0).promise;
    expect((await api.config()).preferences.browser_side_panes.left).toBe(true);
    expect(browserSidePanes.left).toBe(true);

    read.released.resolve();
    await refreshing;
    expect(workspace.info?.label).toBe("Updated workspace label");
    expect(browserSidePanes.left).toBe(true);
  });

  test("an older workspace response cannot undo a completed theme choice", async () => {
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;

    await setThemeChoice("dark");
    expect((await api.config()).preferences.theme).toBe("dark");
    read.released.resolve();
    await refreshing;
    expect(ui.themeChoice).toBe("dark");

    // A rejected stale response must not prevent a later peer change from
    // converging through the ordinary watcher refresh.
    const current = await api.config();
    await api.updateConfig({
      expected_revision: current.revision,
      preferences: { theme: "light" },
    });
    onWatchEvent({ kind: "config_changed" });
    await vi.advanceTimersByTimeAsync(250);
    expect(ui.themeChoice).toBe("light");
    expect(currentPreferences()?.theme).toBe("light");
  });

  test("an older response preserves the served preference identity and the settings overlay", async () => {
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;

    await writePreferences((preferences) => ({ ...preferences, date_format: "us" }));
    expect((await api.config()).preferences.date_format).toBe("us");
    expect(shownPreferences()?.date_format).toBe("us");
    const served = currentPreferences();

    read.released.resolve();
    await refreshing;
    expect(shownPreferences()?.date_format).toBe("us");
    expect(currentPreferences()).toBe(served);
  });

  test.each(["before", "after"] as const)(
    "a read begun during a queued write cannot revert it when the read lands %s PATCH completion",
    async (arrival) => {
      const patch = heldPatch = heldRequest();
      const writing = setThemeChoice("dark");
      operations.push(writing);
      await patch.started.promise;
      // This setter queues behind the held theme PATCH. Neither write can
      // have reached the server when the workspace response is captured.
      setBrowserSidePane("left", true);
      const read = heldWorkspace = heldRequest();
      const refreshing = startRefresh();
      // A correct reader may wait for writes before issuing its GET. Flush
      // ready work without requiring that the network request already began.
      await vi.advanceTimersByTimeAsync(0);

      if (arrival === "before") {
        read.released.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(ui.themeChoice).toBe("dark");
        expect(browserSidePanes.left).toBe(true);
      }

      patch.released.resolve();
      await writing;
      await patchResponse(1).promise;
      expect((await api.config()).preferences.browser_side_panes.left).toBe(true);
      await read.started.promise;
      read.released.resolve();
      await refreshing;
      expect(ui.themeChoice).toBe("dark");
      expect(browserSidePanes.left).toBe(true);
    },
  );

  test("a read waiting for one write also waits for a write queued behind it", async () => {
    const firstPatch = heldPatch = heldRequest();
    const firstWrite = setThemeChoice("dark");
    operations.push(firstWrite);
    await firstPatch.started.promise;

    const refreshing = startRefresh();
    await vi.advanceTimersByTimeAsync(0);
    // Enqueue only after the reader entered its wait, so a one-time snapshot
    // of the write tail cannot account for this second operation.
    const secondPatch = heldPatch = heldRequest();
    setBrowserSidePane("left", true);
    const read = heldWorkspace = heldRequest();
    firstPatch.released.resolve();
    await firstWrite;
    await secondPatch.started.promise;
    read.released.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(ui.themeChoice).toBe("dark");
    expect(browserSidePanes.left).toBe(true);
    secondPatch.released.resolve();
    await patchResponse(1).promise;
    await refreshing;
    expect(ui.themeChoice).toBe("dark");
    expect(browserSidePanes.left).toBe(true);
  });

  test("a read begun after a completed write applies newer server preferences", async () => {
    await setThemeChoice("dark");
    const current = await api.config();
    await api.updateConfig({
      expected_revision: current.revision,
      preferences: { theme: "light", browser_side_panes: { left: true, right: true } },
    });

    await refreshWorkspace();
    expect(ui.themeChoice).toBe("light");
    expect(browserSidePanes).toMatchObject({ left: true, right: true });
    expect(currentPreferences()?.theme).toBe("light");
  });

  test("a local no-op still invalidates a stale read and refreshes without another frame", async () => {
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;

    const current = await api.config();
    await api.updateConfig({
      expected_revision: current.revision,
      preferences: { theme: "dark" },
    });
    // The peer already persisted the same choice. This local intent sends
    // no PATCH and therefore cannot rely on its own config_changed frame.
    await setThemeChoice("dark");
    expect(patchCount).toBe(1);

    read.released.resolve();
    await refreshing;
    expect(ui.themeChoice).toBe("dark");
    await vi.advanceTimersByTimeAsync(250);
    expect(currentPreferences()?.theme).toBe("dark");
    expect(ui.themeChoice).toBe("dark");
  });

  test("bootstrap does not apply an initial response invalidated by a local write", async () => {
    const watch = stubWatch();
    workspace.info = null;
    const read = heldWorkspace = heldRequest();
    const booting = bootstrap();
    operations.push(booting);
    await read.started.promise;

    await setThemeChoice("dark");
    expect(workspace.info).toBeNull();
    read.released.resolve();
    await booting;
    await vi.advanceTimersByTimeAsync(0);

    // The watcher has not reported ready, so it cannot repair a stale boot.
    expect(watch).toHaveBeenCalledTimes(1);
    expect(ui.themeChoice).toBe("dark");
    expect(workspace.info).toMatchObject({ preferences: { theme: "dark" } });
  });

  test.each(["pending read", "pending write"] as const)(
    "bootstrap stopped during a %s leaves preferences unloaded and opens no watcher",
    async (stage) => {
      const watch = stubWatch();
      workspace.info = null;
      if (stage === "pending write") {
        const patch = heldPatch = heldRequest();
        const writing = setThemeChoice("dark");
        operations.push(writing);
        await patch.started.promise;
      } else {
        await setThemeChoice("dark");
      }
      const read = stage === "pending read" ? heldWorkspace = heldRequest() : null;
      const booting = bootstrap();
      operations.push(booting);
      if (read) {
        await read.started.promise;
      } else {
        await vi.advanceTimersByTimeAsync(0);
      }

      stopWorkspaceRefresh();
      const readsAtStop = workspaceReads;
      for (const release of releases) release();
      await Promise.all(operations);
      await vi.advanceTimersByTimeAsync(500);

      expect(workspace.info).toBeNull();
      expect(currentPreferences()).toBeNull();
      expect(ui.themeChoice).toBe("dark");
      expect(watch).not.toHaveBeenCalled();
      expect(workspaceReads).toBe(readsAtStop);
    },
  );

  test("an invalidated refresh with no served record waits for fresh required preferences", async () => {
    workspace.info = null;
    const read = heldWorkspace = heldRequest();
    const refreshing = startRefresh();
    await read.started.promise;
    await setThemeChoice("dark");
    read.released.resolve();
    await refreshing;

    expect(workspace.info).toBeNull();
    expect(currentPreferences()).toBeNull();
    expect(ui.themeChoice).toBe("dark");
    demoStore.data.metadata.label = "Fresh preferences";
    const fresh = heldWorkspace = heldRequest();
    const readsBeforeRetry = workspaceReads;
    await vi.advanceTimersByTimeAsync(250);
    expect(workspaceReads).toBe(readsBeforeRetry + 1);
    expect(workspace.info).toBeNull();

    fresh.released.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(workspace.info).toMatchObject({ label: "Fresh preferences", preferences: { theme: "dark" } });
    expect(ui.themeChoice).toBe("dark");
  });

  test.each([
    { stage: "pending read", owner: "teardown", stop: teardown },
    { stage: "pending write", owner: "teardown", stop: teardown },
    { stage: "pending read", owner: "stopWorkspaceRefresh", stop: stopWorkspaceRefresh },
    { stage: "pending write", owner: "stopWorkspaceRefresh", stop: stopWorkspaceRefresh },
  ])(
    "a refresh stopped during a $stage neither applies nor starts another read after $owner",
    async ({ stage, stop }) => {
      const beforeTeardown = workspace.info;
      demoStore.data.metadata.label = "Late workspace response";
      let refreshing: Promise<void>;
      if (stage === "pending read") {
        const read = heldWorkspace = heldRequest();
        refreshing = startRefresh();
        await read.started.promise;
        await setThemeChoice("dark");
      } else {
        const patch = heldPatch = heldRequest();
        const writing = setThemeChoice("dark");
        operations.push(writing);
        await patch.started.promise;
        refreshing = startRefresh();
        await vi.advanceTimersByTimeAsync(0);
      }

      stop();
      const readsAtTeardown = workspaceReads;
      for (const release of releases) release();
      await Promise.all(operations);
      await refreshing;
      await vi.advanceTimersByTimeAsync(500);

      expect(workspace.info).toBe(beforeTeardown);
      expect(ui.themeChoice).toBe("dark");
      expect(workspaceReads).toBe(readsAtTeardown);
    },
  );

  test("stopping a scheduled refresh cancels it and leaves the next frame able to refresh", async () => {
    const readsBeforeSchedule = workspaceReads;
    onWatchEvent({ kind: "config_changed" });
    stopWorkspaceRefresh();
    await vi.advanceTimersByTimeAsync(500);
    expect(workspaceReads).toBe(readsBeforeSchedule);

    onWatchEvent({ kind: "config_changed" });
    await vi.advanceTimersByTimeAsync(250);
    expect(workspaceReads).toBe(readsBeforeSchedule + 1);
  });

  test("config_changed still applies a different window's preferences", async () => {
    const current = await api.config();
    await api.updateConfig({
      expected_revision: current.revision,
      preferences: { theme: "dark", browser_side_panes: { left: true, right: false } },
    });
    onWatchEvent({ kind: "config_changed" });
    await vi.advanceTimersByTimeAsync(250);

    expect(ui.themeChoice).toBe("dark");
    expect(browserSidePanes.left).toBe(true);
    expect(currentPreferences()?.theme).toBe("dark");
  });
});
