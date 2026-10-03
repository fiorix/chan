// The additive Global window commands that mirror the WebView native menu.
// Importing the module is the registration side effect;
// allCommands()/availableCommands() then expose the catalog.
//
// Close window's row runs against the real store: it discards the window's
// session before it asks the desktop to close the window, and the discard is
// what stops every later save of the session by the page, so the desktop's
// close of the record is not written back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allCommands,
  availableCommands,
  type CommandContext,
} from "../commands";
import {
  __testResetSessionDiscarded,
  __testSetBootstrapHydrated,
  scheduleSessionSave,
} from "../store.svelte";
import { fileTab, resetLayout } from "../../__tests__/tabs";

import "./global";

type TauriWindow = typeof window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };

function ctx(): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    // Full caps keep the requirement gate open; these tests pin the
    // per-command availability predicates on their own.
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
  };
}

function categoryOf(id: string): string | undefined {
  return allCommands().find((c) => c.id === id)?.category;
}

function idsIn(c: CommandContext): Set<string> {
  return new Set(availableCommands(c).map((cmd) => cmd.id));
}

afterEach(() => {
  delete (window as TauriWindow).__TAURI__;
});

describe("Global window commands", () => {
  it("registers Reload and Open Inspector under Global", () => {
    expect(categoryOf("app.window.reload")).toBe("Global");
    expect(categoryOf("app.window.devtools")).toBe("Global");
  });

  it("offers Reload in every window", () => {
    expect(idsIn(ctx()).has("app.window.reload")).toBe(true);
  });

  it("gates Open Inspector to the desktop shell", () => {
    // Web: no Tauri runtime, so the browser's own DevTools stand in.
    expect(idsIn(ctx()).has("app.window.devtools")).toBe(false);
    // Desktop: a Tauri runtime is present, so the command is offered.
    (window as TauriWindow).__TAURI__ = {};
    expect(idsIn(ctx()).has("app.window.devtools")).toBe(true);
  });

  it("registers Hide window under Global, gated to the desktop shell", () => {
    expect(categoryOf("app.window.hide")).toBe("Global");
    // Web: the bury IPC is an explicit no-op, so the entry is not offered.
    expect(idsIn(ctx()).has("app.window.hide")).toBe(false);
    (window as TauriWindow).__TAURI__ = {};
    expect(idsIn(ctx()).has("app.window.hide")).toBe(true);
  });

  it("offers Hide window in a standalone terminal window on desktop", () => {
    // A terminal-only window is a library window with the same red-dot hide
    // semantics; the entry ignores the window mode (the id is also in
    // TERMINAL_ONLY_COMMANDS, so the chan:command bridge agrees).
    (window as TauriWindow).__TAURI__ = {};
    expect(
      idsIn({ ...ctx(), terminalOnly: true }).has("app.window.hide"),
    ).toBe(true);
  });

  it("registers New window and Close window under Global", () => {
    expect(categoryOf("app.window.new")).toBe("Global");
    expect(categoryOf("app.window.close")).toBe("Global");
  });

  it("gates New window to the desktop shell", () => {
    // Web: the browser has no equivalent for the desktop window IPC.
    expect(idsIn(ctx()).has("app.window.new")).toBe(false);
    // Desktop: the invoking window tells the host which sibling to create.
    (window as TauriWindow).__TAURI__ = {};
    expect(idsIn(ctx()).has("app.window.new")).toBe(true);
  });

  it("gates Close window to the desktop shell", () => {
    // Web: the browser owns its own window and tab lifecycle.
    expect(idsIn(ctx()).has("app.window.close")).toBe(false);
    // Desktop: the host can discard the invoking window.
    (window as TauriWindow).__TAURI__ = {};
    expect(idsIn(ctx()).has("app.window.close")).toBe(true);
  });

  it("offers Close window in a standalone terminal window on desktop", () => {
    (window as TauriWindow).__TAURI__ = {};
    expect(
      idsIn({ ...ctx(), terminalOnly: true }).has("app.window.close"),
    ).toBe(true);
  });

  it("offers New window in a standalone terminal window on desktop", () => {
    // The desktop routes a terminal record to another terminal, so this id
    // remains in TERMINAL_ONLY_COMMANDS.
    (window as TauriWindow).__TAURI__ = {};
    expect(
      idsIn({ ...ctx(), terminalOnly: true }).has("app.window.new"),
    ).toBe(true);
  });
});

describe("Close window's row on the desktop", () => {
  /// The session requests the page sends and the commands it gives the
  /// desktop, in the order they are made.
  let events: string[];

  beforeEach(() => {
    events = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        events.push(cmd);
        return Promise.resolve();
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/api/session")) events.push(`${init?.method} session`);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    __testSetBootstrapHydrated(true);
    __testResetSessionDiscarded();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    __testResetSessionDiscarded();
    __testSetBootstrapHydrated(false);
    resetLayout([]);
  });

  /// Every save of the window's session the page makes on its own: the
  /// debounced one a layout change schedules, and the one at a pagehide.
  async function pageSaves(): Promise<void> {
    scheduleSessionSave();
    await vi.advanceTimersByTimeAsync(2_000);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
  }

  it("a window the row has not closed saves its session", async () => {
    resetLayout([fileTab({ id: "kept-open", path: "notes/kept-open.md" })]);

    await pageSaves();

    expect(events).toEqual(["PUT session"]);
  });

  it("discards the window's session before it asks the desktop, and no save of the page follows", async () => {
    resetLayout([fileTab({ id: "closing", path: "notes/closing.md" })]);

    allCommands().find((command) => command.id === "app.window.close")!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["DELETE session", "request_close_window"]);

    await pageSaves();

    expect(events).toEqual(["DELETE session", "request_close_window"]);
  });
});
