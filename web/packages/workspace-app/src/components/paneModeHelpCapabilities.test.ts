// @vitest-environment jsdom
//
// Every cap in the Hybrid Nav cheatsheet is a clickable <button> that
// synthesizes a keystroke into App.svelte's handlePaneModeKey, so a row the
// window cannot run is not merely noise: it is a focusable, screen-reader
// announced control that does nothing. The overlay therefore renders exactly
// the rows whose capability this window has, and this test mounts it in all
// three shapes to prove it -- rather than pinning the filter's source text,
// which cannot tell whether the tags and the handler guards still agree. The
// Dashboard row follows the launcher's New dashboard rule instead: every
// window but a control terminal and a tmux window.
//
// `windowCaps` is read once at module load, so each shape sets its `?kind=`
// and its `<meta name="chan-files">` / `<meta name="chan-drafts">` BEFORE
// importing the component (same discipline as
// state/standaloneBootstrap.test.ts).

import { afterEach, describe, expect, test, vi } from "vitest";
import { serveMeta } from "../__tests__/standalone";

let host: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
/// Held from the same module registry the component was imported from:
/// `vi.resetModules()` hands the component a fresh Svelte runtime, and
/// mounting it with the previous one crashes inside Svelte's internals.
let svelte: typeof import("svelte") | null = null;

/// Mount the cheatsheet in a window of the given shape and return every
/// action label it renders.
async function actionsFor(
  kind: string,
  tenantFiles: boolean,
  tenantDrafts = false,
  tmux = false,
): Promise<string[]> {
  vi.resetModules();
  window.history.replaceState({}, "", `/?kind=${kind}&w=w-1`);
  serveMeta("chan-files", tenantFiles);
  serveMeta("chan-drafts", tenantDrafts);
  svelte = await import("svelte");
  (await import("../state/tabs.svelte")).paneMode.tmux = tmux ? { splits: [], resized: [] } : null;
  const PaneModeHelp = (await import("./PaneModeHelp.svelte")).default;
  host = document.createElement("div");
  document.body.appendChild(host);
  app = svelte.mount(PaneModeHelp, { target: host });
  return [...host.querySelectorAll("dd")].map((el) => el.textContent?.trim() ?? "");
}

afterEach(() => {
  if (app && svelte) svelte.unmount(app);
  host?.remove();
  host = null;
  app = null;
  svelte = null;
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
});

describe("Hybrid Nav cheatsheet shows only the keys this window can run", () => {
  test("a workspace window lists every action", async () => {
    const actions = await actionsFor("", false);
    for (const action of [
      "Stage Terminal",
      "Stage File Browser",
      "Stage Graph",
      "Stage Dashboard",
      "Stage New Draft",
      "Stage Excalidraw",
      "Right file browser dock",
    ]) {
      expect(actions, action).toContain(action);
    }
  });

  test("a standalone window with a filesystem lists the browser and the Dashboard, not the workspace surfaces", async () => {
    const actions = await actionsFor("terminal", true);
    // The file surface this window really has, and the Dashboard it opens.
    expect(actions).toContain("Stage File Browser");
    expect(actions).toContain("Right file browser dock");
    expect(actions).toContain("Left file browser dock");
    expect(actions).toContain("Stage Dashboard");
    // The workspace surfaces it does not: App.svelte returns early on each of
    // these, so advertising them would be advertising dead keys.
    for (const action of [
      "Stage Graph",
      "Stage New Draft",
      "Stage Excalidraw",
    ]) {
      expect(actions, action).not.toContain(action);
    }
    // Everything capability-free stays.
    expect(actions).toContain("Stage Terminal");
    expect(actions).toContain("Move focus");
  });

  test("a standalone window with a draft store adds the draft rows, not the workspace ones", async () => {
    const actions = await actionsFor("terminal", true, true);
    for (const action of [
      "Stage File Browser",
      "Stage New Draft",
      "Stage Excalidraw",
      "Stage Terminal",
      "Stage Dashboard",
    ]) {
      expect(actions, action).toContain(action);
    }
    // Graph stays a workspace surface.
    expect(actions).not.toContain("Stage Graph");
  });

  test("a terminals-only window lists the Dashboard and no file or workspace surface, and drops the empty Dock group", async () => {
    const actions = await actionsFor("terminal", false);
    expect(actions).toContain("Stage Terminal");
    expect(actions).toContain("Stage Dashboard");
    for (const action of [
      "Stage File Browser",
      "Stage Graph",
      "Stage New Draft",
      "Stage Excalidraw",
      "Right file browser dock",
    ]) {
      expect(actions, action).not.toContain(action);
    }
    // A group whose every row was filtered renders no bare header.
    const titles = [...(host?.querySelectorAll("h4") ?? [])].map((el) =>
      el.textContent?.trim(),
    );
    expect(titles).not.toContain("Dock");
  });

  test("a tmux window lists the splits and resizes, and no tile swap, staged tab or side flip", async () => {
    const actions = await actionsFor("terminal", true, true, true);
    for (const action of ["Move focus", "Split right", "Split down", "Move divider left", "Equalize panes", "Commit draft"]) {
      expect(actions, action).toContain(action);
    }
    for (const action of [
      "Swap tile with neighbour",
      "Stage Terminal",
      "Stage File Browser",
      "Stage Dashboard",
      "Stage New Draft",
      "Flip pane",
    ]) {
      expect(actions, action).not.toContain(action);
    }
  });

  test("a control terminal is terminals-only too, and lists no Dashboard", async () => {
    const actions = await actionsFor("control", true);
    expect(actions).toContain("Stage Terminal");
    expect(actions).not.toContain("Stage File Browser");
    expect(actions).not.toContain("Stage Dashboard");
  });
});
