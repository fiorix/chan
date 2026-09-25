// @vitest-environment jsdom
//
// A settle that times out is a real failure of the test that mounted the app,
// and it has to read as one: the rest of the teardown still runs, so the app
// is unmounted, the timer wrappers are gone and the demo is uninstalled before
// the next test starts, instead of that test failing for a reason of its own.

import { mount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { chanFetch } from "../api/transport";
import KindChip from "../components/KindChip.svelte";
import type { MockWorkspaceData } from "./data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "./install";
import { teardownDemoApp } from "./teardown";
import { trackTimers } from "./timers";

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [{ path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" }],
  };
}

afterEach(() => {
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
});

describe("the demo app teardown", () => {
  test("still unmounts, releases and uninstalls when the settle rejects", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timers = trackTimers();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 30);
    installDemoWorkspace(demoData());
    const target = document.createElement("div");
    document.body.append(target);
    const mounted = [mount(KindChip, { target, props: { kind: "document" } }) as Record<string, unknown>];
    window.history.replaceState(null, "", "#s=left-behind");

    const settled = await teardownDemoApp({
      mounted,
      timers,
      settle: () => Promise.reject(new Error("the settle timed out")),
    }).catch((e: unknown) => e);
    await new Promise((r) => realSetTimeout(r, 60));
    const late = await chanFetch("/api/workspace").catch((e: unknown) => e);

    expect({
      rejectedWith: String(settled),
      unmounted: target.childElementCount === 0 && mounted.length === 0,
      timersReleased: globalThis.setTimeout === realSetTimeout && !fired,
      uninstalled: (late as Error).name,
      hash: window.location.hash,
    }).toEqual({
      rejectedWith: "Error: the settle timed out",
      unmounted: true,
      timersReleased: true,
      uninstalled: "DemoTransportUninstalledError",
      hash: "",
    });
  });
});
