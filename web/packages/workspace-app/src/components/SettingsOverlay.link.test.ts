// A link into Settings: `openSettings` names a section and a field of the
// settings index, and the surface switches to the section, brings the field
// into view, focuses its first control and marks it for a moment, whether
// the surface was closed or already open on another section.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import SettingsOverlay from "./SettingsOverlay.svelte";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { settingsPreferences } from "../__tests__/settings";
import { demoWorkspaceInfo } from "../demo/data";
import { closeSettings, openSettings, settingsPanel, workspace } from "../state/store.svelte";

let target: HTMLElement;
let view: Record<string, unknown> | null = null;
/// The elements brought into view, in order.
let scrolled: Element[];
/// Answers the config read. Replaced by a case that holds the read back.
let config: () => Response | Promise<Response>;
const hadScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await tick();
    await Promise.resolve();
  }
}

function activeTab(): string | undefined {
  return target.querySelector('.section-tab[aria-current="page"]')?.textContent?.trim();
}

function anchor(field: string): HTMLElement | null {
  return target.querySelector<HTMLElement>(`[data-setting="${field}"]`);
}

function marked(): string[] {
  return [...target.querySelectorAll<HTMLElement>("[data-setting-landed]")].map(
    (el) => el.dataset.setting!,
  );
}

function surface(): HTMLElement {
  return target.querySelector<HTMLElement>(".settings")!;
}

beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element): void {
    scrolled.push(this);
  };
  config = () => json({ revision: 1, preferences: settingsPreferences(), workspaces: [] });
  recordRequests((request) =>
    request.path === "/api/config" ? config() : new Response(null, { status: 404 }),
  );
  target = document.createElement("div");
  document.body.append(target);
  view = mount(SettingsOverlay, { target }) as Record<string, unknown>;
});

afterEach(() => {
  vi.useRealTimers();
  if (view) unmount(view);
  view = null;
  settingsPanel.open = false;
  settingsPanel.target = null;
  workspace.info = null;
  stopRecordingRequests();
  if (hadScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", hadScrollIntoView);
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  document.body.innerHTML = "";
});

describe("a link into Settings, opened from closed", () => {
  test("shows the field's section, brings the field into view, focuses its control and marks it", async () => {
    openSettings({ section: "terminal", field: "terminal.engine" });
    await settle();

    expect(settingsPanel.open).toBe(true);
    expect(activeTab()).toBe("Terminal");
    const field = anchor("terminal.engine")!;
    expect(field.querySelector("h3")?.textContent).toBe("Terminal engine (new terminals)");
    expect(scrolled).toEqual([field]);
    // A choice is entered on the option it holds.
    const held = field.querySelector<HTMLInputElement>('input[type="radio"]:checked')!;
    expect(held.value).toBe("xterm");
    expect(document.activeElement).toBe(held);
    expect(marked()).toEqual(["terminal.engine"]);
    expect(settingsPanel.target).toBeNull();
  });

  test("waits for the form, which mounts once the config has loaded", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    config = async () => {
      await held;
      return json({ revision: 1, preferences: settingsPreferences(), workspaces: [] });
    };
    openSettings({ section: "editor", field: "editor.dateFormat" });
    await settle();
    expect(activeTab()).toBe("Editor");
    expect(anchor("editor.dateFormat")).toBeNull();
    expect(marked()).toEqual([]);
    // The surface holds the keyboard meanwhile.
    expect(document.activeElement).toBe(surface());

    release();
    await settle();

    const select = anchor("editor.dateFormat")!.querySelector("select");
    expect(document.activeElement).toBe(select);
    expect(marked()).toEqual(["editor.dateFormat"]);
  });

  test("a control the user reached for during the wait keeps the focus", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    config = async () => {
      await held;
      return json({ revision: 1, preferences: settingsPreferences(), workspaces: [] });
    };
    openSettings({ section: "editor", field: "editor.dateFormat" });
    await settle();
    const close = target.querySelector<HTMLElement>('button[aria-label="Close"]')!;
    close.focus();

    release();
    await settle();

    expect(anchor("editor.dateFormat")).not.toBeNull();
    expect(document.activeElement).toBe(close);
    expect(marked()).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  test("the mark is gone a moment later", async () => {
    vi.useFakeTimers();
    openSettings({ section: "global", field: "global.theme" });
    await settle();
    expect(marked()).toEqual(["global.theme"]);

    vi.advanceTimersByTime(1500);
    expect(marked()).toEqual(["global.theme"]);
    vi.advanceTimersByTime(200);
    expect(marked()).toEqual([]);
  });

  test("lands on a control that shares its heading with others, not on the first of them", async () => {
    const preferences = {
      ...settingsPreferences(),
      terminal_colors: {
        mode: "custom",
        custom: { background: "#000000", foreground: "#ffffff", cursor: "#00ff00", contrast: "auto" },
      },
    };
    config = () => json({ revision: 1, preferences, workspaces: [] });
    openSettings({ section: "terminal", field: "terminal.colors.cursor" });
    await settle();

    const row = anchor("terminal.colors.cursor")!;
    expect(row.querySelector("label")?.textContent?.trim()).toBe("Cursor");
    expect(document.activeElement).toBe(row.querySelector("input"));
    expect(marked()).toEqual(["terminal.colors.cursor"]);
  });

  test("lands on the privacy mode's terminal masking under its own heading", async () => {
    openSettings({ section: "global", field: "global.privacyTerminalMasking" });
    await settle();

    const field = anchor("global.privacyTerminalMasking")!;
    expect(field.querySelector("h3")?.textContent).toBe("Mask terminal secrets in privacy mode");
    expect(document.activeElement).toBe(field.querySelector('input[type="checkbox"]'));
    expect(marked()).toEqual(["global.privacyTerminalMasking"]);
  });

  test("opens Keyboard Shortcuts on its filter", async () => {
    openSettings({ section: "shortcuts", field: "shortcuts.grid" });
    await settle();

    expect(activeTab()).toBe("Keyboard Shortcuts");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(target.querySelector('input[aria-label="Filter commands"]')),
    );
  });

  test("a section alone is shown with the surface holding the focus", async () => {
    openSettings({ section: "graph" });
    await settle();

    expect(activeTab()).toBe("Graph");
    expect(document.activeElement).toBe(surface());
    expect(marked()).toEqual([]);
    expect(scrolled).toEqual([]);
    expect(settingsPanel.target).toBeNull();
  });

  test("a field is shown under its own section, whatever section the link names", async () => {
    openSettings({ section: "global", field: "search.indexing" });
    await settle();

    expect(activeTab()).toBe("Search");
    expect(marked()).toEqual(["search.indexing"]);
  });
});

describe("a link into Settings that is already open", () => {
  test("moves to a field in another section", async () => {
    // A dock is a field of a window over a workspace.
    workspace.info = demoWorkspaceInfo(
      {
        metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
        files: [],
      },
      settingsPreferences(),
    );
    openSettings();
    await settle();
    expect(activeTab()).toBe("Global");
    expect(document.activeElement).toBe(surface());

    openSettings({ section: "browser", field: "browser.rightDock" });
    await settle();

    expect(activeTab()).toBe("File browser");
    const dock = anchor("browser.rightDock")!;
    expect(dock.querySelector("h3")?.textContent).toBe("Right file browser dock");
    expect(document.activeElement).toBe(dock.querySelector('input[type="checkbox"]'));
    expect(marked()).toEqual(["browser.rightDock"]);
  });

  test("moves the focus and the mark between two fields of one section", async () => {
    openSettings({ section: "terminal", field: "terminal.scrollback" });
    await settle();
    expect(marked()).toEqual(["terminal.scrollback"]);

    openSettings({ section: "terminal", field: "terminal.bodyTheme" });
    await settle();

    expect(marked()).toEqual(["terminal.bodyTheme"]);
    expect(anchor("terminal.bodyTheme")!.contains(document.activeElement)).toBe(true);
    expect(scrolled).toEqual([anchor("terminal.scrollback"), anchor("terminal.bodyTheme")]);
  });
});

describe("a link the window cannot follow", () => {
  test("a field its section does not render leaves the surface holding the focus, and is given up on", async () => {
    vi.useFakeTimers();
    // The colour rows render only while custom colours are on.
    openSettings({ section: "terminal", field: "terminal.colors.cursor" });
    await settle();
    expect(activeTab()).toBe("Terminal");
    expect(document.activeElement).toBe(surface());
    expect(marked()).toEqual([]);

    // Past the wait, the field appearing lands nowhere.
    vi.advanceTimersByTime(3000);
    const late = document.createElement("div");
    late.dataset.setting = "terminal.colors.cursor";
    target.querySelector(".content")!.append(late);
    await settle();

    expect(document.activeElement).toBe(surface());
    expect(marked()).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  test("a section the window does not have leaves the surface where it was", async () => {
    openSettings({ section: "editor" });
    await settle();

    // This window has no workspace, so no This workspace section.
    openSettings({ section: "workspace", field: "workspace.reports" });
    await settle();

    expect(activeTab()).toBe("Editor");
    expect(marked()).toEqual([]);
    expect(settingsPanel.target).toBeNull();
  });

  test("a wait ends when the surface closes, and the next open starts unmarked", async () => {
    vi.useFakeTimers();
    openSettings({ section: "terminal", field: "terminal.colors.cursor" });
    await settle();
    closeSettings();
    await settle();
    vi.advanceTimersByTime(3000);

    openSettings({ section: "terminal", field: "terminal.term" });
    await settle();

    expect(marked()).toEqual(["terminal.term"]);
    expect(document.activeElement).toBe(
      target.querySelector('input[aria-label="Terminal TERM value"]'),
    );
  });
});
