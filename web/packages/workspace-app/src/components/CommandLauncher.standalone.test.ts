// @vitest-environment jsdom
//
// The launcher in a window with no workspace behind it: the rail leaves the
// Workspace scope out, the list has no Workspace section, and a typed query
// still finds a workspace command, dimmed, saying what it needs. The window's
// capabilities are read once at module load, so the test plants the `?kind=`
// marker and the Files capability meta before it imports the state modules
// (the state/standaloneBootstrap.test.ts discipline). A stand-in deck prints
// the rows.

import { afterEach, expect, test, vi } from "vitest";
import { serveMeta } from "../__tests__/standalone";

vi.mock("@chan/web-shared/CommandDeck.svelte", async () => import("./CommandLauncher.testDeck.svelte"));
vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => ({ library_id: "lib", windows: [], workspaces: [] })),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: vi.fn(),
}));

const href = window.location.href;
let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = "";
  serveMeta("chan-files", false);
  window.history.replaceState({}, "", href);
  vi.resetModules();
});

test("a window with no workspace lists no Workspace scope and dims a workspace command", async () => {
  vi.resetModules();
  window.history.replaceState({}, "", "/?kind=terminal&w=w-mini");
  serveMeta("chan-files", true);
  // The fresh module graph has a Svelte runtime of its own, which must be
  // the one that mounts the component it compiled.
  const { mount, tick, unmount } = await import("svelte");
  const flush = async (): Promise<void> => {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  };
  const { windowCaps } = await import("../state/windowCaps");
  expect(windowCaps).toMatchObject({ workspace: false, files: true });
  const { registerCommands } = await import("../state/commands");
  const store = await import("../state/store.svelte");
  const { default: CommandLauncher } = await import("./CommandLauncher.svelte");
  const run = vi.fn();
  registerCommands([
    {
      id: "standalone.search", title: "Search workspace", category: "Global", scope: "workspace",
      requirement: "workspace", available: () => true, run,
    },
    {
      id: "standalone.reload", title: "Reload window", category: "Global", scope: "window",
      requirement: "any", available: () => true, run,
    },
  ]);

  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(CommandLauncher, { target });
  teardown = () => {
    store.closeCommandLauncher();
    unmount(component);
  };
  store.openCommandLauncher();
  await flush();

  const orbs = [...target.querySelectorAll<HTMLElement>(".probe-scope")].map((orb) => orb.dataset.id);
  expect(orbs).toEqual(["app", "pane", "window", "settings", "computers"]);
  const rows = () => [...target.querySelectorAll<HTMLElement>(".probe-row")];
  expect(rows().map((row) => row.dataset.section)).not.toContain("Workspace");
  expect(rows().map((row) => row.textContent)).toContain("Reload window");

  const field = target.querySelector(".probe-query") as HTMLInputElement;
  field.value = "search workspace";
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
  const found = rows().find((row) => row.textContent === "Search workspace");
  expect(found?.dataset).toMatchObject({ disabled: "true", subtitle: "Needs a workspace window" });
});
