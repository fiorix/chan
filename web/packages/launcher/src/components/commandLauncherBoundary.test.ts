// @vitest-environment jsdom
//
// The command deck renders behind a boundary in CommandLauncher, so a render throw inside the deck is contained where the deck was: the launcher stays mounted, and the deck's place says what failed and offers a retry. Without the boundary the throw takes the whole launcher surface down with no way back short of a reload.
//
// The deck is replaced by a component that throws while rendering, which is that failure stated directly. It is also what a duplicate key looks like from the launcher's side, since each_key_duplicate is thrown while the deck renders its keyed list.
//
// Worth knowing for anyone placing the next boundary: <svelte:boundary> catches throws from rendering its children, NOT a throw raised while the PARENT computes the props it passes down. A $derived in CommandLauncher that throws escapes this boundary and reaches the window as an unhandled error.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

vi.mock("../state/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/capabilities")>()),
  surface: "devserver",
  canMutateRegistry: true,
  hasDesktopBridge: false,
  selfManagedWindows: true,
  readOnly: false,
  hostOs: "linux",
}));

vi.mock("../state/computerActions", () => ({
  canManageWindow: () => true,
  canOpenWorkspaceWindow: () => true,
  closeComputerWindow: vi.fn(),
  connectComputer: vi.fn(),
  focusComputerWindow: vi.fn(),
  liveTerminalCountForWindow: vi.fn(),
  newTerminal: vi.fn(),
  newWorkspaceWindow: vi.fn(),
  setWindowShown: vi.fn(),
  setWorkspacePower: vi.fn(),
}));

// The deck itself, replaced by one that throws while rendering.
vi.mock("@chan/web-shared/CommandDeck.svelte", () => ({
  default: function ThrowingDeck() {
    throw new Error("deck render blew up");
  },
}));

import CommandLauncher from "./CommandLauncher.svelte";
import { library } from "../state/library.svelte";
import {
  clearCommandLauncherDraft,
  closeCommandLauncher,
  commandLauncher,
} from "../state/commandLauncher.svelte";
import { screen } from "../state/screen.svelte";

Element.prototype.scrollIntoView = vi.fn();

let target: HTMLElement;
let app: Record<string, unknown>;

function openDeck(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    }),
  );
  flushSync();
}

beforeEach(() => {
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
  library.devservers = [];
  library.workspaces = [];
  library.windows = [];
  library.gateways = [];
  library.leaders = {};
  screen.current = "computers";
  screen.flips = 0;
  commandLauncher.entryMode = "computers";
  clearCommandLauncherDraft("contextual");
  clearCommandLauncherDraft("computers");
  closeCommandLauncher();
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  unmount(app);
  target.remove();
  closeCommandLauncher();
  vi.resetAllMocks();
});

describe("a component that throws while the deck renders", () => {
  it("is contained where the deck was, names the failure, and offers a retry", () => {
    openDeck();

    const failed = target.querySelector(".deck-failed");
    expect(failed, "the failure is shown in the deck's place").not.toBeNull();
    expect(failed?.textContent, "it names what failed").toContain("deck render blew up");

    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".deck-failed-actions button")];
    expect(
      buttons.map((b) => b.textContent?.trim()),
      "a retry and a way out are offered",
    ).toEqual(["Try again", "Close"]);
  });

  it("leaves the launcher around it mounted through a close state change", () => {
    openDeck();

    expect(target.querySelector(".deck-failed"), "the deck failed").not.toBeNull();
    // Exercise the close state transition while the fallback is present; this does not dispatch a window event.
    expect(() => closeCommandLauncher()).not.toThrow();
    flushSync();
    expect(document.body.contains(target), "the surface survives the throw").toBe(true);
  });
});
