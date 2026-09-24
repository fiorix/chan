// A call that reaches the transport after a test uninstalled the demo
// workspace is a leak from the test that mounted the app: a bootstrap step, a
// poll or a debounce that outlived its teardown. It has to fail with an error
// that says so, not fall through to Node's own fetch, whose relative-URL
// rejection names neither the demo transport nor the test.

import { afterEach, describe, expect, test } from "vitest";

import { chanFetch } from "../api/transport";
import type { MockWorkspaceData } from "./data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "./install";

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
});

describe("the demo transport after uninstall", () => {
  test("serves while installed", async () => {
    installDemoWorkspace(demoData());

    const res = await chanFetch("/api/workspace");

    expect(res.ok).toBe(true);
  });

  test("fails a late call with a named error that carries its URL", async () => {
    installDemoWorkspace(demoData());
    uninstallDemoWorkspace();

    await expect(chanFetch("/api/workspace")).rejects.toMatchObject({
      name: "DemoTransportUninstalledError",
      message: expect.stringContaining("/api/workspace"),
    });
  });

  test("fails a late call the same way when it carries a request init", async () => {
    installDemoWorkspace(demoData());
    uninstallDemoWorkspace();

    await expect(chanFetch("/api/fs?dir=", { method: "GET" })).rejects.toMatchObject({
      name: "DemoTransportUninstalledError",
      message: expect.stringContaining("/api/fs?dir="),
    });
  });
});
