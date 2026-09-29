// @vitest-environment jsdom
//
// A status that is not transient can be dismissed from the bar. Most error
// writes set the text alone and no kind; such a status never clears on its
// own, so the pill offers Dismiss. A transient status clears itself and
// offers none.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import { api } from "../api/client";
import AppStatusBar from "./AppStatusBar.svelte";
import FileInfoBody from "./FileInfoBody.svelte";
import { dismissStatus, setTransientStatus, tree, ui, workspace } from "../state/store.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  document.body.innerHTML = "";
  dismissStatus();
  vi.clearAllTimers();
  vi.useRealTimers();
  tree.entries = [];
  workspace.info = null;
  vi.restoreAllMocks();
});

function statusBar(): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(AppStatusBar, { target }));
  flushSync();
  return target;
}

test("a failed copy of a path can be dismissed", async () => {
  vi.spyOn(api, "inspector").mockResolvedValue(null as never);
  vi.spyOn(api, "reportFileStream").mockResolvedValue(null as never);
  vi.spyOn(api, "graphStream").mockResolvedValue({ nodes: [], edges: [] });
  workspace.info = { root: "/home/me/ws", label: "ws" } as never;
  tree.entries = [{ path: "notes/a.md", is_dir: false, size: 3, mtime: 1 }] as never;
  const body = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(FileInfoBody, { target: body, props: { path: "notes/a.md" } }));
  flushSync();
  const bar = statusBar();

  // jsdom has no Clipboard API, so the copy fails and the inspector writes
  // its error with no kind.
  body.querySelector<HTMLButtonElement>(".path-toggle")!.click();
  flushSync();
  body.querySelector<HTMLButtonElement>('[aria-label="Copy absolute path to clipboard"]')!.click();
  await vi.waitFor(() => expect(ui.status).toBe("copy failed: Clipboard unavailable"));
  await tick();
  expect(ui.statusKind, "the inspector sets no kind").toBeNull();

  const dismiss = bar.querySelector<HTMLButtonElement>('[aria-label="dismiss status"]');
  expect(dismiss, "the failed copy offers Dismiss").not.toBeNull();
  dismiss!.click();
  flushSync();
  expect(ui.status).toBeNull();
});

test("a transient status offers no Dismiss", () => {
  setTransientStatus("Copied path");
  const bar = statusBar();
  expect(bar.querySelector('[aria-label="status message"]')?.textContent).toContain("Copied path");
  expect(bar.querySelector('[aria-label="dismiss status"]')).toBeNull();
});

test("a bare replacement inside a transient window offers Dismiss", async () => {
  vi.useFakeTimers();
  setTransientStatus("Copied path");
  const bar = statusBar();
  ui.status = "copy failed: unavailable";
  await tick();
  const dismiss = bar.querySelector<HTMLButtonElement>('[aria-label="dismiss status"]');
  expect(dismiss, "replacement text is not owned by the transient timer").not.toBeNull();
  dismiss!.click();
  await tick();
  expect(ui.status, "Dismiss clears replacement text").toBeNull();
  expect(vi.getTimerCount(), "Dismiss retires the timer").toBe(0);
});

test("a bare clear followed by ordinary text offers Dismiss", async () => {
  vi.useFakeTimers();
  setTransientStatus("Copied path");
  const bar = statusBar();
  ui.status = null;
  await tick();
  ui.status = "upload failed: unavailable";
  await tick();
  expect(bar.querySelector('[aria-label="dismiss status"]'), "ordinary text after clear is dismissable").not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  expect(ui.status).toBe("upload failed: unavailable");
  expect(bar.querySelector('[aria-label="dismiss status"]')).not.toBeNull();
});

test("an expired transient owner cannot claim the same text written later", async () => {
  vi.useFakeTimers();
  setTransientStatus("Copied path");
  const bar = statusBar();
  ui.status = "copy failed: unavailable";
  await vi.advanceTimersByTimeAsync(3000);
  ui.status = "Copied path";
  await tick();
  expect(bar.querySelector('[aria-label="dismiss status"]'), "expired owner is retired after replacement").not.toBeNull();
});

test("a warnings action keeps its own action after replacing a transient", async () => {
  vi.useFakeTimers();
  setTransientStatus("Copied path");
  const bar = statusBar();
  ui.status = "Workspace warnings";
  ui.statusAction = { kind: "workspace-warnings", label: "Workspace warnings" };
  await tick();
  expect(bar.querySelector('[aria-label="dismiss status"]')).toBeNull();
  expect(bar.querySelector('[aria-label="open workspace warnings"]')?.tagName).toBe("BUTTON");
  await vi.advanceTimersByTimeAsync(3000);
  expect(ui.status).toBe("Workspace warnings");
  expect(ui.statusAction?.kind).toBe("workspace-warnings");
});
