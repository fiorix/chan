import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buryLibraryWindow,
  createLibraryWindow,
  focusLibraryWindow,
  type LibraryWindowBridge,
} from "./libraryWindows";
import { resetHostVocabularyForTests } from "./nativeVocabulary";
import type { ScopedLibraryWindow } from "./libraryCommand";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

/// A popup handle shaped like the browser one the deck drives: the browser
/// path reads `location.href` to decide whether the named window is fresh,
/// then names, navigates, and focuses it.
interface FakePopup {
  location: { href: string };
  name: string;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakePopup(href = "about:blank"): FakePopup {
  return { location: { href }, name: "", focus: vi.fn(), close: vi.fn() };
}

function asDesktop(invoke: (cmd: string, args?: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke },
    configurable: true,
  });
}

/// What Tauri itself produces when the app's ACL does not grant a command. The
/// rejection happens before any handler runs, so this text is Tauri's and never
/// chan's. A release build emits the short form; a debug build emits one of
/// several diagnostics, of which `unreferenced` is what an app that has never
/// heard of the command produces and `denied` is what an explicit denial
/// produces. All three are from tauri 2.11.2 (`webview/mod.rs`,
/// `ipc/authority.rs`).
type RefusalForm = "release" | "unreferenced" | "denied";

function aclRefusal(cmd: string, form: RefusalForm): string {
  if (form === "release") return `Command ${cmd} not allowed by ACL`;
  if (form === "unreferenced") return `${cmd} not allowed. Command not found`;
  return `${cmd} explicitly denied on origin https://a--b.c.usr.example\n\nreferenced by: capability: workspace-window, permission: allow-create-library-window`;
}

/// A webview whose app grants some commands and refuses others. Every other
/// fake here is a webview that grants everything or a browser that is not a
/// webview at all, and neither can express the state that breaks: a
/// gateway-served page is delivered by the remote devserver while the ACL
/// gating its invokes comes from the locally installed app, so the page can
/// call a command that app has never heard of.
function asDesktopWithout(
  ungranted: readonly string[],
  form: RefusalForm = "release",
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (cmd: string) => {
    if (ungranted.includes(cmd)) throw new Error(aclRefusal(cmd, form));
    return null;
  });
  asDesktop(invoke);
  return invoke;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected the call to reject");
  return outcome;
}

function bridge(overrides: Partial<LibraryWindowBridge> = {}): LibraryWindowBridge {
  return {
    runAction: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    currentWindowId: () => "w-self",
    ...overrides,
  };
}

function scopedWindow(overrides: Partial<ScopedLibraryWindow> = {}): ScopedLibraryWindow {
  return {
    window_id: "w-other",
    kind: "terminal",
    title: "Terminal",
    ordinal: 1,
    label: "",
    workspace_path: null,
    connected: true,
    hidden: false,
    control: false,
    can_act: true,
    launch_path: "/lib-0a1b/index.html?w=w-other",
    ...overrides,
  };
}

afterEach(() => {
  delete (window as W).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  resetHostVocabularyForTests();
});

/// `window.open` returns null in every chan-desktop webview, gateway-served and
/// local alike, so neither library-window path may reach a popup there. These
/// drive the real functions and observe `window.open` itself rather than
/// inspecting source order, because the reverted attempt proved a branch can
/// take the desktop path and still be wrong.
describe("chan-desktop native library windows", () => {
  test("creating a terminal invokes the native command and never opens a popup", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);
    const host = bridge();

    await createLibraryWindow(host, { action: "new_terminal" });

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_library_window", {
      kind: "terminal",
      workspaceId: null,
    });
    // The scoped HTTP action mints a browser-origin record the desktop watcher
    // refuses to open, so the native path must not also run it.
    expect(host.runAction).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });

  test("creating a workspace window carries the workspace id, not a path", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);

    await createLibraryWindow(bridge(), {
      action: "new_workspace_window",
      workspace_id: "notes-1a2b3c4d",
    });

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_library_window", {
      kind: "workspace",
      workspaceId: "notes-1a2b3c4d",
    });
  });

  test("focusing invokes the native command and never opens a popup", async () => {
    const open = vi.spyOn(window, "open");
    const invoke = vi.fn().mockResolvedValue(null);
    asDesktop(invoke);
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ hidden: true }));

    expect(open).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("focus_library_window", { windowId: "w-other" });
    // The native command persists hidden=false itself, so a second unhide over
    // HTTP would be a duplicated authority, not a safety net.
    expect(host.runAction).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });

  test("hiding and closing another window need no popup handle", async () => {
    const open = vi.spyOn(window, "open");
    asDesktop(vi.fn().mockResolvedValue(null));
    const host = bridge();

    await buryLibraryWindow(host, scopedWindow(), false);
    await buryLibraryWindow(host, scopedWindow(), true);

    expect(open).not.toHaveBeenCalled();
    expect(host.runAction).toHaveBeenNthCalledWith(1, {
      action: "set_window_visibility",
      window_id: "w-other",
      hidden: true,
    });
    expect(host.runAction).toHaveBeenNthCalledWith(2, {
      action: "close_window",
      window_id: "w-other",
    });
  });

  test("a refused native create rejects instead of reporting success", async () => {
    asDesktop(vi.fn().mockRejectedValue(new Error("not allowed")));
    const host = bridge();

    await expect(createLibraryWindow(host, { action: "new_terminal" })).rejects.toThrow(
      "not allowed",
    );
    expect(host.refresh).not.toHaveBeenCalled();
  });
});

/// Being inside a Tauri webview does not mean the app grants this command.
/// The two answers diverge only where the page and the ACL are independently
/// versioned, which is exactly a gateway-served window, and there is no
/// fallback to reach for: `window.open` returns null in every chan webview,
/// which is why the native path exists at all. So the whole correction is what
/// the user is told.
describe("a chan-desktop whose ACL does not grant the command", () => {
  test("creating reports the app is behind the page, not the raw ACL string", async () => {
    const open = vi.spyOn(window, "open");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    asDesktopWithout(["create_library_window"]);
    const host = bridge();

    const error = await rejection(createLibraryWindow(host, { action: "new_terminal" }));

    // Taken off the user's screen, not thrown away: which command was withheld
    // is what a report of this needs.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("create_library_window"),
      "Command create_library_window not allowed by ACL",
    );

    // The command name is Tauri's vocabulary, not the user's.
    expect(error.message).not.toMatch(/create_library_window/);
    expect(error.message).not.toMatch(/ACL/);
    expect(error.message).toMatch(/chan-desktop/);
    expect(error.message).toMatch(/update/i);
    // There is no destination to fall back to, so a popup here would be a
    // second failure with a worse message.
    expect(open).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
  });

  test("focusing reports it the same way", async () => {
    const open = vi.spyOn(window, "open");
    asDesktopWithout(["focus_library_window"]);
    const host = bridge();

    const error = await rejection(focusLibraryWindow(host, scopedWindow()));

    expect(error.message).not.toMatch(/focus_library_window/);
    expect(error.message).not.toMatch(/ACL/);
    expect(error.message).toMatch(/chan-desktop/);
    expect(open).not.toHaveBeenCalled();
    expect(host.runAction).not.toHaveBeenCalled();
  });

  test("a debug-build refusal reads the same as a release one", async () => {
    // Release and debug builds reject in different words. A correction that
    // only recognised one would leave the other quoting Tauri at the user.
    asDesktopWithout(["create_library_window"], "unreferenced");

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).not.toMatch(/create_library_window/);
    expect(error.message).not.toMatch(/Command not found/);
    expect(error.message).toMatch(/update/i);
  });

  test("an explicit denial reads the same, and leaks no capability names", async () => {
    // The other debug wording, and the only one that names the capability and
    // permission behind the denial. None of that belongs on a user's screen.
    asDesktopWithout(["create_library_window"], "denied");

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).not.toMatch(/create_library_window/);
    expect(error.message).not.toMatch(/capability|permission|allow-/);
    expect(error.message).toMatch(/update/i);
  });

  test("a command the same app does grant still runs", async () => {
    // Non-vacuity: the refusal above is the ACL withholding one command, not a
    // webview that fails everything.
    const invoke = asDesktopWithout(["create_library_window"]);
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow());

    expect(invoke).toHaveBeenCalledWith("focus_library_window", { windowId: "w-other" });
    expect(host.refresh).toHaveBeenCalled();
  });

  test("a granted command that fails in the handler keeps its own reason", async () => {
    // The handler's text is the only account of what actually went wrong, so
    // the wrapper must not replace it with a guess about the app's version.
    asDesktop(vi.fn().mockRejectedValue(new Error("no devserver is connected for library lib-0a1b")));

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).toMatch(/no devserver is connected for library lib-0a1b/);
    expect(error.message).not.toMatch(/update/i);
  });

  // The two tests below are a pair, and between them they pin both halves of
  // what separates a withheld command from a command that ran and failed. Each
  // supplies exactly one half and must still be reported as a handler failure,
  // so dropping either half from the check turns one of them red.

  test("a handler failure that merely names the command is not read as a refusal", async () => {
    asDesktop(vi.fn().mockRejectedValue(new Error("create_library_window timed out")));

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).toMatch(/timed out/);
    expect(error.message).not.toMatch(/update/i);
  });

  test("a handler failure that merely says 'not allowed' is not read as a refusal", async () => {
    // chan's own commands do use this wording about their arguments, so the
    // phrase alone cannot be what decides it.
    asDesktop(vi.fn().mockRejectedValue(new Error("picked file name is not allowed: \"..\"")));

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).toMatch(/picked file name is not allowed/);
    expect(error.message).not.toMatch(/update/i);
  });
});

/// An app that can say what it grants turns the guesswork off: a command
/// absent from the advertised vocabulary becomes a version statement made
/// BEFORE any invoke, and a refusal of a command the app does advertise
/// becomes an authorization statement, because the two call for different
/// actions. Apps predating the advertisement are the earlier describe block:
/// their query fails and every path stays interpretation-based.
describe("a chan-desktop that advertises its vocabulary", () => {
  function asDesktopAdvertising(
    commands: string[],
    behavior: (cmd: string) => Promise<unknown> = async () => null,
  ): ReturnType<typeof vi.fn> {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "native_vocabulary") {
        return { version: "0.86.0", build: "0123abcd4567", commands };
      }
      return behavior(cmd);
    });
    asDesktop(invoke);
    return invoke;
  }

  test("a command absent from the vocabulary rejects up front as a version statement", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = asDesktopAdvertising(["focus_library_window"]);
    const host = bridge();

    const error = await rejection(createLibraryWindow(host, { action: "new_terminal" }));

    // Absence is known before asking, so the refused invoke never fires.
    expect(invoke).not.toHaveBeenCalledWith("create_library_window", expect.anything());
    expect(error.message).toMatch(/does not have/);
    expect(error.message).toMatch(/update chan-desktop/i);
    expect(error.message).not.toMatch(/create_library_window|ACL/);
    // The withheld command still lands in the console for a report.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("create_library_window"));
    expect(host.refresh).not.toHaveBeenCalled();
  });

  test("an advertised command the ACL still refuses reads as authorization, not version", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    asDesktopAdvertising(["create_library_window"], async (cmd) => {
      throw new Error(aclRefusal(cmd, "release"));
    });

    const error = await rejection(createLibraryWindow(bridge(), { action: "new_terminal" }));

    expect(error.message).toMatch(/authorization/);
    expect(error.message).toMatch(/not a version difference/);
    expect(error.message).not.toMatch(/older than/);
    expect(error.message).not.toMatch(/create_library_window|ACL/);
  });

  test("an advertised command that runs keeps running", async () => {
    const invoke = asDesktopAdvertising(["create_library_window"]);
    const host = bridge();

    await createLibraryWindow(host, { action: "new_terminal" });

    expect(invoke).toHaveBeenCalledWith("create_library_window", {
      kind: "terminal",
      workspaceId: null,
    });
    expect(host.refresh).toHaveBeenCalled();
  });

  test("the vocabulary is queried once and cached for the page", async () => {
    const invoke = asDesktopAdvertising(["create_library_window", "focus_library_window"]);
    const host = bridge();

    await createLibraryWindow(host, { action: "new_terminal" });
    await focusLibraryWindow(host, scopedWindow());

    const queries = invoke.mock.calls.filter(([cmd]) => cmd === "native_vocabulary");
    expect(queries).toHaveLength(1);
  });

  test("a failed vocabulary query is retried on the next action", async () => {
    // The minted origin grant can land after this window opens, so a refused
    // query must not pin "cannot say" for the life of the page.
    let queries = 0;
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "native_vocabulary") {
        queries += 1;
        if (queries === 1) throw new Error(aclRefusal(cmd, "release"));
        return { version: "0.86.0", build: "0123abcd4567", commands: ["focus_library_window"] };
      }
      return null;
    });
    asDesktop(invoke);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host = bridge();

    // First action: the query fails, the invoke proceeds uninformed.
    await createLibraryWindow(host, { action: "new_terminal" });
    // Second action: the query succeeds and now suppresses the absent command.
    const error = await rejection(createLibraryWindow(host, { action: "new_terminal" }));

    expect(queries).toBe(2);
    expect(error.message).toMatch(/does not have/);
  });
});

/// The browser path is the one this change must leave alone. These fail if the
/// desktop branch ever swallows it.
describe("browser library windows still use window.open", () => {
  test("creating opens a popup before the action and navigates it", async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge({
      runAction: vi.fn().mockResolvedValue({ window: scopedWindow() }),
    });

    await createLibraryWindow(host, { action: "new_terminal" });

    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(host.runAction).toHaveBeenCalledWith({ action: "new_terminal" });
    expect(popup.name).toBe("w-other");
    expect(popup.location.href).toBe("/lib-0a1b/index.html?w=w-other");
    expect(popup.focus).toHaveBeenCalled();
  });

  test("a blocked popup throws and a failed action closes the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(createLibraryWindow(bridge(), { action: "new_terminal" })).rejects.toThrow(
      /blocked/i,
    );

    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge({ runAction: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(createLibraryWindow(host, { action: "new_terminal" })).rejects.toThrow("boom");
    expect(popup.close).toHaveBeenCalled();
  });

  test("focusing a hidden window unhides it over HTTP and raises the popup", async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ hidden: true }));

    expect(open).toHaveBeenCalledWith("", "w-other");
    expect(host.runAction).toHaveBeenCalledWith({
      action: "set_window_visibility",
      window_id: "w-other",
      hidden: false,
    });
    expect(popup.location.href).toBe("/lib-0a1b/index.html?w=w-other");
    expect(popup.focus).toHaveBeenCalled();
  });

  test("focusing this window reuses it instead of opening a popup", async () => {
    const open = vi.spyOn(window, "open");
    const host = bridge();

    await focusLibraryWindow(host, scopedWindow({ window_id: "w-self" }));

    expect(open).not.toHaveBeenCalled();
  });
});
