// @vitest-environment jsdom
//
// Every cap in the Hybrid Nav cheatsheet is a clickable <button> that
// synthesizes a keystroke into App.svelte's handlePaneModeKey, so a row the
// window cannot run is not merely noise: it is a focusable, screen-reader
// announced control that does nothing. The overlay therefore renders exactly
// the rows whose capability this window has, and this test mounts it in all
// three shapes to prove it -- rather than pinning the filter's source text,
// which cannot tell whether the tags and the handler guards still agree.
//
// `windowCaps` is read once at module load, so each shape sets its `?kind=`
// and its `<meta name="chan-files">` BEFORE importing the component (same
// discipline as state/standaloneBootstrap.test.ts).

import { afterEach, describe, expect, test, vi } from "vitest";

let host: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
/// Held from the same module registry the component was imported from:
/// `vi.resetModules()` hands the component a fresh Svelte runtime, and
/// mounting it with the previous one crashes inside Svelte's internals.
let svelte: typeof import("svelte") | null = null;

function serveFiles(on: boolean): void {
  document.head.querySelector('meta[name="chan-files"]')?.remove();
  if (!on) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "chan-files");
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

/// Mount the cheatsheet in a window of the given shape and return every
/// action label it renders.
async function actionsFor(kind: string, tenantFiles: boolean): Promise<string[]> {
  vi.resetModules();
  window.history.replaceState({}, "", `/?kind=${kind}&w=w-1`);
  serveFiles(tenantFiles);
  svelte = await import("svelte");
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
  serveFiles(false);
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
      "Stage Diagram",
      "Toggle right-side file browser dock",
    ]) {
      expect(actions, action).toContain(action);
    }
  });

  test("a standalone window with a filesystem lists the browser, not the workspace surfaces", async () => {
    const actions = await actionsFor("terminal", true);
    // The file surface this window really has.
    expect(actions).toContain("Stage File Browser");
    expect(actions).toContain("Toggle right-side file browser dock");
    expect(actions).toContain("Toggle left-side file browser dock");
    // The workspace surfaces it does not: App.svelte returns early on each of
    // these, so advertising them would be advertising dead keys.
    for (const action of [
      "Stage Graph",
      "Stage Dashboard",
      "Stage New Draft",
      "Stage Diagram",
    ]) {
      expect(actions, action).not.toContain(action);
    }
    // Everything capability-free stays.
    expect(actions).toContain("Stage Terminal");
    expect(actions).toContain("Move focus");
  });

  test("a terminals-only window lists neither, and drops the empty Dock group", async () => {
    const actions = await actionsFor("terminal", false);
    expect(actions).toContain("Stage Terminal");
    for (const action of [
      "Stage File Browser",
      "Stage Graph",
      "Stage Dashboard",
      "Stage New Draft",
      "Stage Diagram",
      "Toggle right-side file browser dock",
    ]) {
      expect(actions, action).not.toContain(action);
    }
    // A group whose every row was filtered renders no bare header.
    const titles = [...(host?.querySelectorAll("h4") ?? [])].map((el) =>
      el.textContent?.trim(),
    );
    expect(titles).not.toContain("Dock");
  });

  test("a control terminal is terminals-only too", async () => {
    const actions = await actionsFor("control", true);
    expect(actions).toContain("Stage Terminal");
    expect(actions).not.toContain("Stage File Browser");
  });
});
