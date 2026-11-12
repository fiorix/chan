// @vitest-environment jsdom
//
// The launcher's Settings scope over the real settings index and the real
// catalog: every field this window shows is listed once under its rail
// section, a toggle and a choice change through the index with the overlay
// closed, a refused write is reported, and a setting a command also changes
// is left to the command among typed results. A stand-in deck prints the
// rows; `/api/config` is the recorded double the settings suites use.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@chan/web-shared/CommandDeck.svelte", async () => import("./CommandLauncher.testDeck.svelte"));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => ({ library_id: "lib", windows: [], workspaces: [] })),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: vi.fn(),
}));

import CommandLauncher from "./CommandLauncher.svelte";
import { SETTINGS_SECTIONS } from "./settings/sections";
import { resetShownPreferencesForTests } from "./settings/preferenceState.svelte";
import { settingEntry, settingsIndex } from "./settings/settingsIndex";
import {
  WORKSPACE_STATE_MAX_AGE_MS,
  resetWorkspaceStateForTests,
} from "./settings/workspace/workspaceState.svelte";
import { api } from "../api/client";
import type { Preferences } from "../api/types";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { settingsPreferences } from "../__tests__/settings";
import { resetLayout } from "../__tests__/tabs";
import { demoWorkspaceInfo } from "../demo/data";
import { allCommands, commandContext } from "../state/commands";
import { clearRecentCommands } from "../state/commands/recent.svelte";
import * as statusBus from "../state/notify.svelte";
import { screensaver } from "../state/screensaver.svelte";
import {
  __testSetStandalonePreferences,
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
  ui,
  workspace,
} from "../state/store.svelte";

const REFUSAL = "configuration is locked";

/// Serve `preferences` as the global config and hand them to this window. A
/// write is refused while `refusing` says so.
function serve(preferences: Preferences, refusing: () => boolean = () => false) {
  let revision = 1;
  let stored = preferences as unknown as Record<string, unknown>;
  const writes: Record<string, unknown>[] = [];
  recordRequests((request) => {
    if (request.path !== "/api/config") return new Response(null, { status: 404 });
    if (request.method === "PATCH") {
      const slice = (request.body as { preferences: Record<string, unknown> }).preferences;
      writes.push(slice);
      if (refusing()) return json({ error: REFUSAL }, { status: 400 });
      stored = { ...stored, ...slice };
      revision += 1;
    }
    return json({ revision, preferences: stored, workspaces: [] });
  });
  __testSetStandalonePreferences(preferences);
  return { writes };
}

/// Serve `preferences` to a window with a workspace behind it, which holds
/// them as part of its workspace record.
function serveWorkspace(preferences: Preferences) {
  const config = serve(preferences);
  workspace.info = demoWorkspaceInfo(
    {
      metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    },
    preferences,
  );
  return config;
}

const LOCK_UNLOADED = {
  enabled: false,
  timeout_secs: 300,
  theme: "plain",
  pin_set: false,
  locked: false,
  loaded: false,
} as const;

const startTheme = { choice: ui.themeChoice, theme: ui.theme };
let component: Record<string, unknown> | null = null;
let target: HTMLElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function rows(): HTMLButtonElement[] {
  return [...target.querySelectorAll<HTMLButtonElement>(".probe-row")];
}

function row(title: string): HTMLButtonElement {
  const found = rows().find((candidate) => candidate.textContent === title);
  if (!found) throw new Error(`missing row ${title}; listed: ${rows().map((r) => r.textContent).join(", ")}`);
  return found;
}

async function openSettingsScope(): Promise<void> {
  openCommandLauncher();
  await flush();
  (target.querySelector('.probe-scope[data-id="settings"]') as HTMLButtonElement).click();
  await flush();
}

async function type(query: string): Promise<void> {
  openCommandLauncher();
  await flush();
  const field = target.querySelector(".probe-query") as HTMLInputElement;
  field.value = query;
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
}

beforeEach(() => {
  sessionStorage.clear();
  clearRecentCommands();
  closeCommandLauncher();
  clearLauncherDraft();
  resetLayout();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  closeCommandLauncher();
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = "";
  stopRecordingRequests();
  __testSetStandalonePreferences(null);
  workspace.info = null;
  Object.assign(screensaver, LOCK_UNLOADED);
  resetShownPreferencesForTests();
  resetWorkspaceStateForTests();
  ui.themeChoice = startTheme.choice;
  ui.theme = startTheme.theme;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the Settings scope over the settings index", () => {
  test("lists every field this window shows once, under its rail section, in rail order", async () => {
    serve(settingsPreferences());
    await openSettingsScope();
    const labels = new Map(SETTINGS_SECTIONS.map((section) => [section.id as string, section.label]));
    const expected = SETTINGS_SECTIONS.flatMap((section) =>
      settingsIndex()
        .filter((spec) => spec.section === section.id && spec.available())
        .map((spec) => `${labels.get(spec.section)}: ${spec.label}`),
    );
    expect(expected.length).toBeGreaterThan(20);
    expect(rows().map((r) => `${r.dataset.section}: ${r.textContent}`)).toEqual([
      ...expected,
      "Settings: Settings",
    ]);
    // Keyboard Shortcuts is the index's own entry, listed once.
    expect(rows().filter((r) => r.textContent === "Keyboard Shortcuts")).toHaveLength(1);
  });

  test("lists the two docks among the File browser fields over a workspace, and not without one", async () => {
    const docks = ["browser.leftDock", "browser.rightDock"].map((id) => `setting:${id}`);
    const listed = (): (string | undefined)[] =>
      rows()
        .filter((r) => r.dataset.section === "File browser")
        .map((r) => r.dataset.id);

    // This window has no workspace, so nothing mirrors a stored dock into
    // its own.
    serve(settingsPreferences());
    await openSettingsScope();
    expect(listed()).toEqual(["setting:browser.vim", "setting:browser.bodyTheme"]);

    workspace.info = demoWorkspaceInfo(
      {
        metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
        files: [],
      },
      settingsPreferences(),
    );
    await flush();
    expect(listed()).toEqual([...docks, "setting:browser.vim", "setting:browser.bodyTheme"]);
  });

  test("a toggle flips in place, sends its slice and shows the new value", async () => {
    const config = serve(settingsPreferences());
    const mcp = settingEntry("terminal.mcpEnv");
    await openSettingsScope();
    expect(row(mcp.label).dataset).toMatchObject({ kind: "toggle", value: "off" });

    row(mcp.label).click();
    await vi.waitFor(() => expect(config.writes).toHaveLength(1));
    await flush();
    expect(config.writes[0]).toMatchObject({ terminal: { mcp_env: true } });
    expect(row(mcp.label).dataset.value).toBe("on");
    expect(launcherPanel.open).toBe(true);
  });

  test("a refused write is reported and the row reads the served value again", async () => {
    const notified = vi.spyOn(statusBus, "notify");
    serve(settingsPreferences(), () => true);
    const mcp = settingEntry("terminal.mcpEnv");
    await openSettingsScope();

    row(mcp.label).click();
    await vi.waitFor(() => expect(notified).toHaveBeenCalledExactlyOnceWith(`${mcp.label}: ${REFUSAL}`));
    await flush();
    expect(row(mcp.label).dataset.value).toBe("off");
    expect(launcherPanel.open).toBe(true);
  });

  test("a choice lists the field's own option words with a check on the current one", async () => {
    serve(settingsPreferences());
    const engine = settingEntry("terminal.engine");
    expect(engine.label).toBe("Terminal engine (new terminals)");
    await openSettingsScope();
    expect(row(engine.label).dataset).toMatchObject({ kind: "choice", value: "xterm" });

    row(engine.label).click();
    await flush();
    expect(rows().map((r) => [r.textContent, r.dataset.checked])).toEqual([
      ["ghostty", "false"],
      ["xterm", "true"],
    ]);
  });
});

describe("a setting of this workspace, pressed in the Settings scope", () => {
  test("the press sends no read beside its write, and the row keeps the write's answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The server: a write takes effect as it is answered, and a read sees
    // the state as it arrives. A read that arrives while the write is still
    // unanswered is answered after it, as a slower connection would.
    let enabled = false;
    let writeSent = false;
    let answerWrite = (): void => {};
    const besideTheWrite: (() => void)[] = [];
    vi.spyOn(api, "reportsState").mockImplementation(async () => {
      const seen = { enabled };
      if (writeSent && !enabled) await new Promise<void>((resolve) => besideTheWrite.push(resolve));
      return seen;
    });
    vi.spyOn(api, "reportsEnable").mockImplementation(async () => {
      writeSent = true;
      await new Promise<void>((resolve) => (answerWrite = resolve));
      enabled = true;
      return { enabled };
    });
    vi.spyOn(api, "buildInfo").mockResolvedValue({
      version: "0",
      build: "test",
      features: { embeddings: false },
    });
    serveWorkspace(settingsPreferences());
    const reports = settingEntry("workspace.reports");
    await openSettingsScope();
    await vi.waitFor(() => expect(row(reports.label).dataset.value).toBe("off"));

    // The row has been on screen past the age at which a read asks again.
    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    row(reports.label).click();
    await vi.waitFor(() => expect(writeSent).toBe(true));
    await flush();
    answerWrite();
    await vi.waitFor(() => expect(row(reports.label).dataset.value).toBe("on"));

    for (const answer of besideTheWrite) answer();
    await flush();
    expect(row(reports.label).dataset.value).toBe("on");
    expect(besideTheWrite, "reads sent while the write was unanswered").toHaveLength(0);
    expect(launcherPanel.open).toBe(true);
  });
});

describe("a typed query over the settings index", () => {
  test("applies a theme by its option word in one step", async () => {
    const config = serve(settingsPreferences());
    ui.themeChoice = "light";
    await type("dark");
    const leaf = row(`${settingEntry("global.theme").label}: Dark`);
    expect(leaf.dataset.checked).toBe("false");

    leaf.click();
    await vi.waitFor(() => expect(config.writes).toHaveLength(1));
    expect(config.writes[0]).toEqual({ theme: "dark" });
    expect(ui.themeChoice).toBe("dark");
    expect(launcherPanel.open).toBe(true);
  });

  test("leaves a setting to the command that also changes it", async () => {
    // A workspace window with its screen lock on offers every such setting,
    // so only the rule can keep one out of the typed list.
    serveWorkspace(settingsPreferences());
    Object.assign(screensaver, { ...LOCK_UNLOADED, enabled: true, loaded: true });
    const twins = settingsIndex().filter((spec) => spec.command !== undefined);
    expect(twins.map((spec) => spec.command).sort()).toEqual([
      "app.browser.toggleLeftDock",
      "app.browser.toggleRightDock",
      "app.screensaver.setPin",
    ]);
    for (const spec of twins) expect(spec.available(), spec.id).toBe(true);

    // The Settings scope lists each as a field of its own.
    await openSettingsScope();
    const browsed = rows().map((r) => r.dataset.id);
    for (const spec of twins) expect(browsed, spec.id).toContain(`setting:${spec.id}`);
    (target.querySelector(".probe-clear") as HTMLButtonElement).click();
    await flush();

    const ctx = commandContext();
    for (const spec of twins) {
      const command = allCommands().find((candidate) => candidate.id === spec.command)!;
      expect(command.available(ctx), command.id).toBe(true);
      await type(command.title);
      const ids = rows().map((r) => r.dataset.id);
      expect(ids, command.title).toContain(`command:${command.id}`);
      expect(ids, command.title).not.toContain(`setting:${spec.id}`);
    }
  });
});
