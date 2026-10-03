// @vitest-environment jsdom
//
// The command launcher and the window title read the library that serves a
// window through a capability the server mints for that window. The demo's
// stand-in server mints one in the server's shape and answers it with a
// library that holds no window and no workspace.

import { afterEach, expect, test } from "vitest";

import { loadScopedLibrarySnapshot, resetScopedLibraryCapability } from "../api/libraryCommand";
import type { MockWorkspaceData } from "./data";
import { DemoGraph } from "./graph";
import { installDemoWorkspace, uninstallDemoWorkspace } from "./install";
import { MockReports } from "./report";
import { createDemoFetch } from "./router";
import { MockWorkspaceStore } from "./store";

function demoData(): MockWorkspaceData {
  return {
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 1, textCount: 1 },
    files: [{ path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" }],
  };
}

afterEach(() => {
  resetScopedLibraryCapability();
  uninstallDemoWorkspace();
});

test("a command capability is minted in the server's shape, and its library is empty", async () => {
  const store = new MockWorkspaceStore(demoData());
  const f = createDemoFetch(store, new DemoGraph(store), new MockReports([]));
  const minted = await f("/api/library/command-capabilities", {
    method: "POST",
    body: JSON.stringify({ window_id: "w-1", tenant_prefix: "" }),
  });
  expect(minted.status).toBe(200);
  const { token, ...rest } = (await minted.json()) as { token: string; expires_in_seconds: number };
  expect({ token: typeof token, ...rest }).toEqual({ token: "string", expires_in_seconds: 300 });

  const snapshot = await f(`/api/library/command-capabilities/${encodeURIComponent(token)}`);
  expect({ status: snapshot.status, body: await snapshot.json() }).toEqual({
    status: 200,
    body: { library_id: "demo", windows: [], workspaces: [] },
  });
});

test("the client reads the demo's library through a capability it mints", async () => {
  installDemoWorkspace(demoData());
  await expect(loadScopedLibrarySnapshot()).resolves.toEqual({
    library_id: "demo",
    windows: [],
    workspaces: [],
  });
});
