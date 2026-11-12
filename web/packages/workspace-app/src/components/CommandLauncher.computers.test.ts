// @vitest-environment jsdom
//
// The Computers scope's one entry while this window has no library snapshot.
// It reads Connecting while the first request to the scoped route is
// unanswered, and unavailable once the route has refused, through the requests
// that follow: the deck asks again at each open and at each poll. A route the
// server does not have takes the scope off the rail instead. The route is
// mocked.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const scopedLibrary = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: scopedLibrary.load,
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: vi.fn(),
}));

import CommandLauncher from "./CommandLauncher.svelte";
import { ApiError } from "../api/errors";
import { clearLauncherDraft, launcherDraft, launcherPanel, overlayStack } from "../state/store.svelte";
import { resetLayout } from "../__tests__/tabs";

Element.prototype.scrollIntoView = vi.fn();

let app: Record<string, unknown> | null = null;
let target: HTMLElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function titles(): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent ?? "");
}

beforeEach(() => {
  sessionStorage.clear();
  clearLauncherDraft();
  resetLayout();
  overlayStack.ids = [];
  target = document.createElement("div");
  document.body.append(target);
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
  launcherPanel.open = false;
  overlayStack.ids = [];
  vi.clearAllMocks();
});

test("the Computers entry reads unavailable through a later request once the scoped route has refused", async () => {
  let refuse: (error: unknown) => void = () => {};
  scopedLibrary.load
    .mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    .mockImplementationOnce(() => new Promise(() => {}));
  launcherPanel.open = true;
  await flush();
  (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
  await tick();
  expect(titles(), "the entry while the first request is unanswered").toEqual(["Connecting to this computer\u2026"]);

  refuse(new ApiError(403, "window has no live presence"));
  await flush();
  expect(titles(), "the entry once the route has refused").toEqual(["Computers unavailable"]);
  expect(
    target.querySelector(".deck-result-path")?.textContent,
    "the entry says the window was not granted its library",
  ).toBe("This window was not granted library access");

  launcherPanel.open = false;
  await flush();
  launcherPanel.open = true;
  await flush();
  expect(
    { titles: titles(), requests: scopedLibrary.load.mock.calls.length },
    "the entry during the request that follows the refusal",
  ).toEqual({ titles: ["Computers unavailable"], requests: 2 });
});

test("a server with no scoped route takes the Computers scope off the rail and the launcher off it", async () => {
  let refuse: (error: unknown) => void = () => {};
  scopedLibrary.load.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
  launcherPanel.open = true;
  await flush();
  (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
  await tick();
  expect(titles()).toEqual(["Connecting to this computer\u2026"]);

  refuse(new ApiError(404, "no launcher route"));
  await flush();
  expect(target.querySelector('[aria-label="Computers scope"]'), "the orb").toBeNull();
  expect(launcherDraft.scope, "the scope the launcher stood on").toBeNull();
  expect(titles()).not.toContain("Computers unavailable");
});
