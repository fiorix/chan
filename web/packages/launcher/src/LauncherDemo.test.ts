// Component test: the marketing demo shell. The empty variant stamps first-run
// hint flags on the frame as data attributes (the embedding page positions its
// callout bubbles off them, outside the mock window), tracking live library
// state; the populated variant stamps nothing.

import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import LauncherDemo from "./LauncherDemo.svelte";
import { library } from "./state/library.svelte";
import type { WindowRecord, WorkspaceEntry } from "./api/library";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountDemo(props: Record<string, unknown>): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(LauncherDemo, { target, props });
}

function frame(): HTMLElement {
  return target!.querySelector(".launcher-demo-frame") as HTMLElement;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
});

const termWindow: WindowRecord = {
  window_id: "w-hint-term",
  library_id: "local",
  kind: "terminal",
  title: "🏠 Terminal Window 1",
  ordinal: 1,
  workspace_path: null,
  prefix: "t/hint-1",
  token: "tok_hint",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: false,
};

const localWorkspace: WorkspaceEntry = {
  workspace_id: "ws-hint",
  path: "/Users/you/dev/your-project",
  label: "",
  on: true,
  status: "running",
  library_id: "local",
  devserver_id: null,
  prefix: "ws-hint",
};

describe("LauncherDemo hint attributes", () => {
  it("stamps both hints on the empty variant and clears each with live state", async () => {
    mountDemo({ variant: "empty", hints: true });
    await settle();
    expect(frame().getAttribute("data-hint-terminal")).toBe("true");
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");

    library.windows = [...library.windows, termWindow];
    flushSync();
    expect(frame().getAttribute("data-hint-terminal")).toBeNull();
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");

    library.workspaces = [...library.workspaces, localWorkspace];
    flushSync();
    expect(frame().getAttribute("data-hint-workspace")).toBeNull();

    // Discarding everything brings both back.
    library.windows = library.windows.filter((w) => w.window_id !== termWindow.window_id);
    library.workspaces = library.workspaces.filter(
      (w) => w.workspace_id !== localWorkspace.workspace_id,
    );
    flushSync();
    expect(frame().getAttribute("data-hint-terminal")).toBe("true");
    expect(frame().getAttribute("data-hint-workspace")).toBe("true");
  });

  it("stamps nothing without the hints prop (the home hero)", async () => {
    mountDemo({});
    await settle();
    expect(frame().getAttribute("data-hint-terminal")).toBeNull();
    expect(frame().getAttribute("data-hint-workspace")).toBeNull();
  });
});
