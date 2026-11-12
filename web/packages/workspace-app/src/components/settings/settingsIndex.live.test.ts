// The settings index read and written with the Settings overlay closed, as
// the command launcher uses it: an entry reads the value this window holds,
// a write goes to the place the overlay's own control writes, a toggled row
// shows its new value at once, and a value another window changes arrives
// with the served record.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { privacy, setPrivacy } from "@chan/web-shared/privacy";

import { api } from "../../api/client";
import type { Preferences, SemanticModelRegistry, SemanticState } from "../../api/types";
import { json, recordRequests, stopRecordingRequests } from "../../__tests__/fetch";
import { settingsPreferences } from "../../__tests__/settings";
import { demoWorkspaceInfo } from "../../demo/data";
import { browserKeys, setBrowserVim } from "../../state/browserKeys.svelte";
import { editorToolsPrefs } from "../../state/editorTools.svelte";
import { screensaver } from "../../state/screensaver.svelte";
import {
  __testSetStandalonePreferences,
  surfaceThemeOverride,
  ui,
  workspace,
} from "../../state/store.svelte";
import { resetShownPreferencesForTests } from "./preferenceState.svelte";
import { settingEntry, settingsIndex } from "./settingsIndex";
import SettingRow from "./settingRowTestHost.svelte";
import {
  WORKSPACE_STATE_MAX_AGE_MS,
  loadReports,
  loadSemantic,
  resetWorkspaceStateForTests,
  setSemanticEnabled,
} from "./workspace/workspaceState.svelte";

const REFUSAL = "configuration is locked";
const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;
// jsdom defines no theme tokens, so the standard colours are the reader's
// fallbacks.
const STANDARD = { background: "#1c1c1e", foreground: "#ebebf0", cursor: "#58a6ff" };

type Config = {
  /// The `preferences` slice of every PATCH /api/config, in order.
  writes: Record<string, unknown>[];
  /// What the server holds after the writes it took.
  stored(): Preferences;
};

/// Serve `preferences` as the global config and hand them to this window as
/// a window with no workspace holds them. A write is refused while
/// `refusing` says so.
function serve(preferences: Preferences, refusing: () => boolean = () => false): Config {
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
  return { writes, stored: () => stored as unknown as Preferences };
}

/// The refresh a `config_changed` frame sets off: the window takes the
/// record the server holds.
function configChanged(config: Config): void {
  __testSetStandalonePreferences(JSON.parse(JSON.stringify(config.stored())) as Preferences);
}

const startTheme = { choice: ui.themeChoice, theme: ui.theme };
const startControl = ui.terminalControl;
const rows: Array<Record<string, unknown>> = [];

/// Draw the entry `id` as a launcher row does, and read what the row shows.
function drawRow(id: string): () => string {
  const target = document.createElement("div");
  document.body.append(target);
  rows.push(mount(SettingRow, { target, props: { id } }) as Record<string, unknown>);
  return () => {
    flushSync();
    return target.textContent ?? "";
  };
}

afterEach(async () => {
  for (const row of rows.splice(0)) unmount(row);
  document.body.innerHTML = "";
  stopRecordingRequests();
  __testSetStandalonePreferences(null);
  workspace.info = null;
  resetShownPreferencesForTests();
  resetWorkspaceStateForTests();
  ui.themeChoice = startTheme.choice;
  ui.theme = startTheme.theme;
  ui.terminalControl = startControl;
  editorToolsPrefs.stripTrailingWhitespaceOnSave = false;
  setBrowserVim(false);
  await setPrivacy({ enabled: false, mask_terminal_secrets: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a machine preference, with the overlay closed", () => {
  test("a toggle reads the served value, shows a write at once and sends that slice", async () => {
    const config = serve(settingsPreferences());
    const mcp = settingEntry("terminal.mcpEnv");
    expect(mcp.read()).toBe(false);

    const written = mcp.write!(true);
    // Before the server has answered.
    expect(mcp.read()).toBe(true);
    await written;

    expect(config.writes).toEqual([{ terminal: { ...TERMINAL, mcp_env: true } }]);
    expect(mcp.read()).toBe(true);
    configChanged(config);
    expect(mcp.read()).toBe(true);
  });

  test("a second press inside the round trip reads the first one's value", async () => {
    const config = serve(settingsPreferences());
    const mouse = settingEntry("terminal.mouseCapture");
    expect(mouse.read()).toBe(true);

    const first = mouse.write!(!mouse.read());
    const second = mouse.write!(!mouse.read());
    await Promise.all([first, second]);

    expect(config.writes.map((slice) => (slice.terminal as { mouse_capture: boolean }).mouse_capture)).toEqual([
      false,
      true,
    ]);
    expect(mouse.read()).toBe(true);
  });

  test("the served record wins once it replaces the one a write was answered over", async () => {
    const config = serve(settingsPreferences());
    const mcp = settingEntry("terminal.mcpEnv");
    await mcp.write!(true);
    expect(mcp.read()).toBe(true);

    // The server's next record does not hold the value, as after another
    // window wrote over it.
    __testSetStandalonePreferences(settingsPreferences());
    expect(mcp.read()).toBe(false);
    expect(config.writes).toHaveLength(1);
  });

  test("a refused write rejects with the server's word and the served value shows again", async () => {
    let refuse = true;
    const config = serve(settingsPreferences(), () => refuse);
    const strip = settingEntry("editor.stripTrailingWhitespace");

    const written = strip.write!(true);
    expect(strip.read()).toBe(true);
    await expect(written).rejects.toThrow(REFUSAL);
    expect(strip.read()).toBe(false);
    expect(editorToolsPrefs.stripTrailingWhitespaceOnSave).toBe(false);

    refuse = false;
    await strip.write!(true);
    expect(config.writes.at(-1)).toEqual({ strip_trailing_whitespace_on_save: true });
    expect(editorToolsPrefs.stripTrailingWhitespaceOnSave).toBe(true);
  });

  test("a choice reads its option value and writes the one picked", async () => {
    const config = serve(settingsPreferences());
    const spacing = settingEntry("editor.lineSpacing");
    expect(spacing.read()).toBe("standard");

    await spacing.write!("compact");

    expect(config.writes).toEqual([{ line_spacing: "compact" }]);
    expect(spacing.read()).toBe("compact");
  });

  test("the theme re-skins the app at once and writes the choice", async () => {
    const config = serve(settingsPreferences());
    const theme = settingEntry("global.theme");
    expect(theme.read()).toBe("system");

    const written = theme.write!("dark");
    expect(ui.themeChoice).toBe("dark");
    expect(theme.read()).toBe("dark");
    await written;

    expect(config.writes).toEqual([{ theme: "dark" }]);
  });

  test("a body theme pins the surface, and Inherit drops the key", async () => {
    const config = serve(settingsPreferences());
    const body = settingEntry("editor.bodyTheme");
    expect(body.read()).toBe("inherit");

    await body.write!("dark");
    expect(surfaceThemeOverride("editor")).toBe("dark");
    expect(config.writes.at(-1)).toEqual({ hybrid_surface_themes: { editor: "dark" } });
    expect(body.read()).toBe("dark");

    configChanged(config);
    await body.write!("inherit");
    expect(surfaceThemeOverride("editor")).toBeUndefined();
    expect(config.writes.at(-1)).toEqual({ hybrid_surface_themes: {} });
    expect(body.read()).toBe("inherit");
  });

  test("the terminal engine reads the stored engine and writes the other", async () => {
    const preferences = settingsPreferences();
    const config = serve({ ...preferences, terminal: { ...preferences.terminal, ghostty: true } });
    const engine = settingEntry("terminal.engine");
    expect(engine.read()).toBe("ghostty");

    await engine.write!("xterm");

    expect(config.writes).toEqual([{ terminal: { ...TERMINAL, ghostty: false } }]);
    expect(engine.read()).toBe("xterm");
  });

  test("a dock writes its side and keeps the other", async () => {
    const preferences = settingsPreferences();
    const config = serve({ ...preferences, browser_side_panes: { left: false, right: true } });
    const left = settingEntry("browser.leftDock");
    expect(left.read()).toBe(false);

    await left.write!(true);

    expect(config.writes).toEqual([{ browser_side_panes: { left: true, right: true } }]);
    expect(settingEntry("browser.rightDock").read()).toBe(true);
  });

  test("the docks are offered where the window mirrors them into its own: over a workspace", () => {
    const preferences = settingsPreferences();
    serve(preferences);
    const docks = ["browser.leftDock", "browser.rightDock"].map((id) => settingEntry(id));
    expect(docks.map((dock) => dock.available())).toEqual([false, false]);
    // The file browser's other fields are this browser's, in any window.
    expect(settingEntry("browser.vim").available()).toBe(true);

    workspace.info = demoWorkspaceInfo(
      {
        metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
        files: [],
      },
      preferences,
    );
    expect(docks.map((dock) => dock.available())).toEqual([true, true]);
  });

  test("custom terminal colours start from the page's standard colours and open their rows", async () => {
    const config = serve(settingsPreferences());
    const custom = settingEntry("terminal.customColors");
    const contrast = settingEntry("terminal.ansiContrast");
    const cursor = settingEntry("terminal.colors.cursor");
    expect([custom.read(), contrast.available(), cursor.available()]).toEqual([false, false, false]);

    const written = custom.write!(true);
    expect([custom.read(), contrast.available(), cursor.available()]).toEqual([true, true, true]);
    await written;

    expect(config.writes).toEqual([
      { terminal_colors: { mode: "custom", custom: { ...STANDARD, contrast: "auto" } } },
    ]);
    expect(cursor.read()).toBe(STANDARD.cursor);
    expect(contrast.read()).toBe("auto");

    configChanged(config);
    await contrast.write!("light");
    expect(config.writes.at(-1)).toEqual({
      terminal_colors: { mode: "custom", custom: { ...STANDARD, contrast: "light" } },
    });
  });

  test("secret masking reads the stored choice, and Default while none is stored", () => {
    const preferences = settingsPreferences();
    serve(preferences);
    const masking = settingEntry("terminal.secretMasking");
    // Whatever a new terminal of this window would start with.
    ui.terminalControl = false;
    expect(masking.read()).toBe("default");
    ui.terminalControl = true;
    expect(masking.read()).toBe("default");

    for (const [stored, value] of [
      [true, "on"],
      [false, "off"],
    ] as const) {
      __testSetStandalonePreferences({
        ...preferences,
        terminal: { ...preferences.terminal, secret_masking: stored },
      });
      expect(masking.read()).toBe(value);
    }
  });

  test("secret masking writes On and Off as the choice, and Default as its removal", async () => {
    const config = serve(settingsPreferences());
    const masking = settingEntry("terminal.secretMasking");

    for (const [value, sent] of [
      ["on", true],
      ["off", false],
      ["default", null],
    ] as const) {
      const written = masking.write!(value);
      // Before the server has answered.
      expect(masking.read()).toBe(value);
      await written;
      expect(config.writes.at(-1)).toEqual({ terminal: { ...TERMINAL, secret_masking: sent } });
      configChanged(config);
      expect(masking.read()).toBe(value);
    }
    expect(config.writes).toHaveLength(3);
  });

  test("secret masking's Default sends nothing while no choice is stored", async () => {
    const config = serve(settingsPreferences());
    const masking = settingEntry("terminal.secretMasking");

    await masking.write!("default");

    expect(config.writes).toEqual([]);
    expect(masking.read()).toBe("default");
  });

  test("a field edited in the overlay reads as the overlay words its value", () => {
    serve(settingsPreferences());
    expect(
      [
        "editor.fontSize",
        "editor.pageWidth",
        "terminal.scrollback",
        "terminal.term",
        "terminal.fontSize",
        "terminal.backgroundOpacity",
      ].map((id) => settingEntry(id).read()),
    ).toEqual(["Theme", "80%", "50 MB", "xterm-256color", "14 px", "100% (off)"]);
  });

  test("nothing reads before the window has been served its preferences", () => {
    expect(settingEntry("terminal.mcpEnv").read()).toBeNull();
    expect(settingEntry("global.theme").read()).toBeNull();
    expect(settingEntry("terminal.scrollback").read()).toBeNull();
  });

  test("a value another window changed arrives with the served record, in either kind of window", () => {
    const preferences = settingsPreferences();
    const changed = { ...preferences, bubble_overlay_mode: "tray" } as Preferences;
    const bubbles = settingEntry("global.watcherBubbles");

    serve(preferences);
    expect(bubbles.read()).toBe("stack");
    __testSetStandalonePreferences(changed);
    expect(bubbles.read()).toBe("tray");

    __testSetStandalonePreferences(null);
    const data = {
      metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    };
    workspace.info = demoWorkspaceInfo(data, preferences);
    expect(bubbles.read()).toBe("stack");
    workspace.info = demoWorkspaceInfo(data, changed);
    expect(bubbles.read()).toBe("tray");
  });

  test("a row drawn from an entry redraws on a write and on the served record", async () => {
    const config = serve(settingsPreferences());
    const mcp = settingEntry("terminal.mcpEnv");
    const row = drawRow("terminal.mcpEnv");
    expect(row()).toBe("false");

    const written = mcp.write!(true);
    expect(row()).toBe("true");
    await written;

    __testSetStandalonePreferences({
      ...config.stored(),
      terminal: { ...config.stored().terminal, mcp_env: false },
    });
    expect(row()).toBe("false");
  });
});

describe("a value held outside the machine preferences", () => {
  test("privacy mode and its terminal masking are the viewer's own", async () => {
    const config = serve(settingsPreferences());
    const mode = settingEntry("global.privacy");
    const masking = settingEntry("global.privacyTerminalMasking");
    expect([mode.read(), masking.read()]).toEqual([false, false]);

    await mode.write!(true);
    expect(privacy.enabled).toBe(true);
    expect([mode.read(), masking.read()]).toEqual([true, false]);

    await masking.write!(true);
    expect(privacy.mask_terminal_secrets).toBe(true);
    expect(config.writes).toEqual([]);
  });

  test("the file browser's Vim map is this browser's own", async () => {
    const config = serve(settingsPreferences());
    const vim = settingEntry("browser.vim");
    expect(vim.read()).toBe(false);

    await vim.write!(true);

    expect(browserKeys.vim).toBe(true);
    expect(vim.read()).toBe(true);
    expect(config.writes).toEqual([]);
  });
});

describe("a setting of this workspace, with the overlay closed", () => {
  const MODELS: SemanticModelRegistry = {
    current_model: "bge-small",
    models: [
      {
        id: "bge-small",
        label: "BGE small",
        dim: 384,
        size_label: "130 MB",
        note: "",
        default: true,
        downloaded: true,
        current: true,
      },
      {
        id: "bge-m3",
        label: "BGE M3",
        dim: 1024,
        size_label: "2.2 GB",
        note: "",
        default: false,
        downloaded: false,
        current: false,
      },
    ],
  };
  let reportsEnabled: boolean;
  let semanticState: SemanticState;
  let models: SemanticModelRegistry;
  let lock: { enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean };

  beforeEach(() => {
    reportsEnabled = false;
    semanticState = {
      mode: "bm25",
      model_present: true,
      model_name: "bge-small",
      model_path: "/models/bge-small",
      model_size_bytes: 1,
      semantic_enabled: false,
    };
    models = JSON.parse(JSON.stringify(MODELS)) as SemanticModelRegistry;
    lock = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: false };
    vi.spyOn(api, "reportsState").mockImplementation(async () => ({ enabled: reportsEnabled }));
    vi.spyOn(api, "reportsEnable").mockImplementation(async () => ({ enabled: (reportsEnabled = true) }));
    vi.spyOn(api, "reportsDisable").mockImplementation(async () => ({ enabled: (reportsEnabled = false) }));
    vi.spyOn(api, "buildInfo").mockImplementation(async () => ({
      version: "0",
      build: "test",
      features: { embeddings: true },
    }));
    vi.spyOn(api, "semanticState").mockImplementation(async () => ({ ...semanticState }));
    vi.spyOn(api, "semanticModels").mockImplementation(
      async () => JSON.parse(JSON.stringify(models)) as SemanticModelRegistry,
    );
    vi.spyOn(api, "semanticEnable").mockImplementation(async () => {
      semanticState = { ...semanticState, semantic_enabled: true, mode: "hybrid" };
      return { ...semanticState };
    });
    vi.spyOn(api, "semanticDisable").mockImplementation(async () => {
      semanticState = { ...semanticState, semantic_enabled: false, mode: "bm25" };
      return { ...semanticState };
    });
    vi.spyOn(api, "semanticDownload").mockImplementation(async () => {
      semanticState = { ...semanticState, model_present: true };
      return { ...semanticState };
    });
    vi.spyOn(api, "semanticModelPatch").mockImplementation(async (model) => {
      models = { ...models, current_model: model };
      return { ...semanticState };
    });
    vi.spyOn(api, "screensaverState").mockImplementation(async () => ({ ...lock }));
    vi.spyOn(api, "screensaverPatch").mockImplementation(async (body) => {
      lock = { ...lock, ...body };
      return { ...lock };
    });
    workspace.info = demoWorkspaceInfo({
      metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    });
    Object.assign(screensaver, { ...lock, locked: false, loaded: true });
  });

  afterEach(() => {
    Object.assign(screensaver, {
      enabled: false,
      timeout_secs: 300,
      theme: "plain",
      pin_set: false,
      locked: false,
      loaded: false,
    });
  });

  test("chan-reports loads on the first read and a write goes to its endpoint", async () => {
    const entry = settingEntry("workspace.reports");
    expect(entry.read()).toBeNull();
    await vi.waitFor(() => expect(entry.read()).toBe(false));

    await entry.write!(true);

    expect(api.reportsEnable).toHaveBeenCalledTimes(1);
    expect(entry.read()).toBe(true);
  });

  test("a row drawn from an entry starts its load and redraws when the value arrives", async () => {
    // The load starts inside the row's derived read, where writing state
    // throws.
    const row = drawRow("workspace.reports");
    expect(row()).toBe("null");
    await vi.waitFor(() => expect(row()).toBe("false"));
    expect(api.reportsState).toHaveBeenCalledTimes(1);
  });

  test("a refused chan-reports write rejects and reads the server's state back", async () => {
    const entry = settingEntry("workspace.reports");
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    vi.mocked(api.reportsEnable).mockRejectedValue(new Error("index is busy"));

    await expect(entry.write!(true)).rejects.toThrow("index is busy");
    expect(entry.read()).toBe(false);
  });

  test("a write behind one still in flight is refused, and no read asks the server meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entry = settingEntry("workspace.reports");
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    let answer = (): void => {};
    vi.mocked(api.reportsEnable).mockImplementation(async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      return { enabled: (reportsEnabled = true) };
    });

    const first = entry.write!(true);
    await expect(entry.write!(false)).rejects.toThrow("still in progress");
    expect(api.reportsDisable).not.toHaveBeenCalled();

    // The write's own answer is the newer state.
    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    entry.read();
    await Promise.resolve();
    expect(api.reportsState).toHaveBeenCalledTimes(1);

    answer();
    await first;
    expect(entry.read()).toBe(true);
  });

  /// Let the answers already released land.
  async function landed(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /// Hold every chan-reports read from now on: the server reads its state as
  /// the request arrives and answers when the returned function is called.
  function holdReportsReads(): () => void {
    const held: (() => void)[] = [];
    vi.mocked(api.reportsState).mockImplementation(async () => {
      const seen = { enabled: reportsEnabled };
      await new Promise<void>((resolve) => held.push(resolve));
      return seen;
    });
    return () => {
      for (const answer of held.splice(0)) answer();
    };
  }

  test("a read sent before a write and answered after it does not put the old state back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entry = settingEntry("workspace.reports");
    await vi.waitFor(() => expect(entry.read()).toBe(false));

    // The window's copy has aged out, so this read asks the server again.
    const answerReads = holdReportsReads();
    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    entry.read();
    await vi.waitFor(() => expect(api.reportsState).toHaveBeenCalledTimes(2));

    await entry.write!(true);
    expect(entry.read()).toBe(true);

    // The read saw the state the write replaced.
    answerReads();
    await landed();
    expect(entry.read()).toBe(true);
  });

  test("a read sent while a write is under way and answered after it is dropped as well", async () => {
    const entry = settingEntry("workspace.reports");
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    let answerWrite = (): void => {};
    vi.mocked(api.reportsEnable).mockImplementation(async () => {
      await new Promise<void>((resolve) => (answerWrite = resolve));
      return { enabled: (reportsEnabled = true) };
    });

    const written = entry.write!(true);
    // The Settings control mounts meanwhile and reads for itself.
    const answerReads = holdReportsReads();
    const read = loadReports();
    answerWrite();
    await written;
    expect(entry.read()).toBe(true);

    answerReads();
    await read;
    expect(entry.read()).toBe(true);
  });

  test("a semantic search read sent before a write does not put the old state back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entry = settingEntry("workspace.semantic");
    await vi.waitFor(() => expect(entry.read()).toBe(false));

    const held: (() => void)[] = [];
    vi.mocked(api.semanticState).mockImplementation(async () => {
      const seen = { ...semanticState };
      await new Promise<void>((resolve) => held.push(resolve));
      return seen;
    });
    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    entry.read();
    await vi.waitFor(() => expect(held).toHaveLength(1));

    await entry.write!(true);
    expect(entry.read()).toBe(true);

    held[0]!();
    await landed();
    expect(entry.read()).toBe(true);
  });

  test("a read sent while a model downloads and answered after it does not put back what it saw", async () => {
    semanticState = { ...semanticState, model_present: false };
    models.models[0]!.downloaded = false;
    const entry = settingEntry("workspace.semantic");
    const model = settingEntry("workspace.embeddingModel");
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    let finishDownload = (): void => {};
    vi.mocked(api.semanticDownload).mockImplementation(async () => {
      await new Promise<void>((resolve) => (finishDownload = resolve));
      semanticState = { ...semanticState, model_present: true };
      models.models[0]!.downloaded = true;
      return { ...semanticState };
    });
    let finishEnable = (): void => {};
    vi.mocked(api.semanticEnable).mockImplementation(async () => {
      await new Promise<void>((resolve) => (finishEnable = resolve));
      semanticState = { ...semanticState, semantic_enabled: true, mode: "hybrid" };
      return { ...semanticState };
    });

    // The Settings toggle's own write, which downloads the model it lacks.
    const written = setSemanticEnabled(true);
    await vi.waitFor(() => expect(api.semanticDownload).toHaveBeenCalled());

    // A read sent while the download runs, as its poll sends, sees no model
    // on disk and is answered late.
    const held: (() => void)[] = [];
    const answerLate = async <T,>(seen: T): Promise<T> => {
      await new Promise<void>((resolve) => held.push(resolve));
      return seen;
    };
    vi.mocked(api.semanticState).mockImplementationOnce(() => answerLate({ ...semanticState }));
    vi.mocked(api.semanticModels).mockImplementationOnce(() =>
      answerLate(JSON.parse(JSON.stringify(models)) as SemanticModelRegistry),
    );
    const read = loadSemantic();
    await vi.waitFor(() => expect(held).toHaveLength(2));

    finishDownload();
    await vi.waitFor(() => expect(api.semanticEnable).toHaveBeenCalled());
    expect(model.options?.[0]?.label).toBe("BGE small - 384d - 130 MB - downloaded");

    // The late answers land between the download and the enable.
    for (const answer of held) answer();
    await read;
    expect(model.options?.[0]?.label).toBe("BGE small - 384d - 130 MB - downloaded");

    finishEnable();
    await expect(written).resolves.toBeNull();
    expect(entry.read()).toBe(true);
  });

  test("a read answered right behind a model change's own read-back does not put the old model back", async () => {
    const entry = settingEntry("workspace.embeddingModel");
    await vi.waitFor(() => expect(entry.read()).toBe("bge-small"));
    let answerWrite = (): void => {};
    vi.mocked(api.semanticModelPatch).mockImplementation(async (model) => {
      await new Promise<void>((resolve) => (answerWrite = resolve));
      models = { ...models, current_model: model };
      return { ...semanticState };
    });
    // Every read from here on sees the server's state as it is sent and is
    // answered when the test says.
    const held: (() => void)[] = [];
    const answerLate = async <T,>(seen: T): Promise<T> => {
      await new Promise<void>((resolve) => held.push(resolve));
      return seen;
    };
    vi.mocked(api.semanticState).mockImplementation(() => answerLate({ ...semanticState }));
    vi.mocked(api.semanticModels).mockImplementation(() =>
      answerLate(JSON.parse(JSON.stringify(models)) as SemanticModelRegistry),
    );

    const written = entry.write!("bge-m3");
    // Sent while the write is unanswered: it sees the old model.
    const read = loadSemantic();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    answerWrite();
    // The write reads the registry back, which sees the new model.
    await vi.waitFor(() => expect(held).toHaveLength(4));

    // The read-back is answered first and the older read right behind it,
    // before the write has ended.
    for (const answer of [held[2]!, held[3]!, held[0]!, held[1]!]) answer();
    await written;
    await read;
    expect(entry.read()).toBe("bge-m3");
  });

  test("a read in the same turn as a write starts no refresh beside it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entry = settingEntry("workspace.reports");
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    expect(api.reportsState).toHaveBeenCalledTimes(1);
    let answerWrite = (): void => {};
    vi.mocked(api.reportsEnable).mockImplementation(async () => {
      await new Promise<void>((resolve) => (answerWrite = resolve));
      return { enabled: (reportsEnabled = true) };
    });

    // The copy has aged out, and the value is read and its opposite written
    // in one turn, as a press on a row does.
    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    const written = entry.write!(!entry.read());
    await landed();
    expect(api.reportsState).toHaveBeenCalledTimes(1);

    answerWrite();
    await written;
    // A read after the write is free to ask again.
    entry.read();
    await vi.waitFor(() => expect(api.reportsState).toHaveBeenCalledTimes(2));
    expect(entry.read()).toBe(true);
  });

  test("a read asks again only once the window's copy has aged out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const entry = settingEntry("workspace.reports");
    entry.read();
    await vi.waitFor(() => expect(entry.read()).toBe(false));
    expect(api.reportsState).toHaveBeenCalledTimes(1);

    // Another window turned it on.
    reportsEnabled = true;
    entry.read();
    await Promise.resolve();
    expect(api.reportsState).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);
    entry.read();
    await vi.waitFor(() => expect(entry.read()).toBe(true));
    expect(api.reportsState).toHaveBeenCalledTimes(2);
  });

  test("semantic search enables at once when the model is on disk", async () => {
    const entry = settingEntry("workspace.semantic");
    await vi.waitFor(() => expect(entry.read()).toBe(false));

    await entry.write!(true);

    expect(api.semanticDownload).not.toHaveBeenCalled();
    expect(api.semanticEnable).toHaveBeenCalledTimes(1);
    expect(entry.read()).toBe(true);

    await entry.write!(false);
    expect(api.semanticDisable).toHaveBeenCalledTimes(1);
    expect(entry.read()).toBe(false);
  });

  test("semantic search downloads the selected model first when it is missing", async () => {
    semanticState = { ...semanticState, model_present: false };
    models.models[0]!.downloaded = false;
    const entry = settingEntry("workspace.semantic");
    await vi.waitFor(() => expect(entry.read()).toBe(false));

    await entry.write!(true);

    expect(vi.mocked(api.semanticDownload).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.semanticEnable).mock.invocationCallOrder[0]!,
    );
    expect(entry.read()).toBe(true);
  });

  test("the embedding model lists the server's registry in the picker's words and writes a pick", async () => {
    const entry = settingEntry("workspace.embeddingModel");
    expect(entry.options).toEqual([]);
    await vi.waitFor(() => expect(entry.read()).toBe("bge-small"));
    expect(entry.options).toEqual([
      { value: "bge-small", label: "BGE small - 384d - 130 MB - downloaded" },
      { value: "bge-m3", label: "BGE M3 - 1024d - 2.2 GB - not downloaded" },
    ]);

    await entry.write!("bge-m3");

    expect(api.semanticModelPatch).toHaveBeenCalledWith("bge-m3");
    expect(entry.read()).toBe("bge-m3");
  });

  test("the screen lock writes through the running lock, which opens its three settings", async () => {
    const entry = settingEntry("workspace.screenLock");
    const under = ["workspace.screenLock.timeout", "workspace.screenLock.pin", "workspace.screenLock.theme"];
    expect(entry.read()).toBe(false);
    expect(under.map((id) => settingEntry(id).available())).toEqual([false, false, false]);

    await entry.write!(true);

    expect(api.screensaverPatch).toHaveBeenCalledWith({ enabled: true });
    expect(screensaver.enabled).toBe(true);
    expect(entry.read()).toBe(true);
    expect(under.map((id) => settingEntry(id).available())).toEqual([true, true, true]);
    expect(settingEntry("workspace.screenLock.timeout").read()).toBe("300");

    const theme = settingEntry("workspace.screenLock.theme");
    expect(theme.read()).toBe("plain");
    await theme.write!("matrix");
    expect(api.screensaverPatch).toHaveBeenLastCalledWith({ theme: "matrix" });
    expect(screensaver.theme).toBe("matrix");
    expect(theme.read()).toBe("matrix");
  });

  test("a screen lock write shows the state its own answer carries, with no read after it", async () => {
    const entry = settingEntry("workspace.screenLock");
    expect(entry.read()).toBe(false);
    // The server takes writes and has stopped answering reads.
    vi.mocked(api.screensaverState).mockRejectedValue(new Error("offline"));

    await entry.write!(true);

    expect(entry.read()).toBe(true);
    expect(settingEntry("workspace.screenLock.theme").available()).toBe(true);
    // The row is still a toggle, so the change can be taken back.
    await entry.write!(false);
    expect(entry.read()).toBe(false);
  });

  test("a refused screen lock write rejects and the row keeps the state it had", async () => {
    const entry = settingEntry("workspace.screenLock");
    vi.mocked(api.screensaverPatch).mockRejectedValue(new Error("workspace is read-only"));

    await expect(entry.write!(true)).rejects.toThrow("workspace is read-only");

    expect(entry.read()).toBe(false);
    expect(screensaver.loaded).toBe(true);
  });

  test("the PIN entry is worded as its button is, by whether a PIN is stored", () => {
    const pin = settingEntry("workspace.screenLock.pin");
    expect([pin.label, pin.read()]).toEqual(["Screen lock: Set PIN", "not set"]);
    screensaver.pin_set = true;
    expect([pin.label, pin.read()]).toEqual(["Screen lock: Change PIN", "set"]);
  });

  test("a window with no workspace offers none of them and asks the server nothing", async () => {
    workspace.info = null;
    const entries = settingsIndex().filter((spec) => spec.section === "workspace");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((spec) => spec.available())).toEqual([]);
    for (const spec of entries) spec.read();
    await Promise.resolve();
    expect(api.reportsState).not.toHaveBeenCalled();
    expect(api.semanticState).not.toHaveBeenCalled();
  });
});
