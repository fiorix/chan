// @vitest-environment jsdom
//
// A chord saved for a command the catalog has removed: the table this window
// resolves leaves it out, the saved table is written back without it, and the
// status line says how many went. The write takes the rows out of the table
// the server holds, so of several windows that load the same saved table one
// writes and speaks and the rest do neither. Only an id on the retired list is
// dropped, and a window that cannot write preferences sends nothing.

import { afterEach, describe, expect, test } from "vitest";

import { json, recordRequests, stopRecordingRequests, type RecordedRequest } from "../__tests__/fetch";
import { serveMeta } from "../__tests__/standalone";
import { allCommands } from "./commands";
import "./commands/install";
import { updateGlobalConfigSerial } from "./configWrite";
import {
  commandIdForChord,
  hydrateOverrides,
  overrideChordForSlot,
  RETIRED_COMMAND_IDS,
  serializeOverrides,
  type KeymapOverridesWire,
} from "./keymapOverrides.svelte";
import { currentOS, shouldEscapeTerminal, SHORTCUTS } from "./shortcuts";
import { dismissStatus, ui } from "./store.svelte";

const SEARCH = { "app.search.toggle": { web: "Mod+Alt+J" } };
const THEME = { "app.theme.dark": { web: "Mod+Alt+D", macos: "Cmd+Alt+D" } };
const SLIDE = { "app.dashboard.slide.about": { linux: "Mod+Alt+A" } };

type Server = {
  /// The saved table and its revision, as the server holds them now.
  table: KeymapOverridesWire;
  revision: number;
  requests: RecordedRequest[];
  /// The table of every config write this window sent, in order.
  writes: KeymapOverridesWire[];
};

type Stand = {
  /// What another window does between this window's first read and its
  /// write.
  afterFirstRead?: (server: Server) => void;
  /// Answers a write in the server's place.
  refuse?: () => Response | null;
};

/// Serve `table` as the saved shortcuts of a config that takes a write only
/// against the revision it holds, and answers a stale one with a conflict
/// carrying the current config.
function serve(table: KeymapOverridesWire, stand: Stand = {}): Server {
  const server: Server = { table, revision: 1, requests: [], writes: [] };
  const config = () => ({
    revision: server.revision,
    preferences: { shortcuts: server.table },
    workspaces: [],
  });
  let reads = 0;
  server.requests = recordRequests((request) => {
    if (request.path !== "/api/config") return new Response(null, { status: 404 });
    if (request.method !== "PATCH") {
      const read = json(config());
      if (reads++ === 0) stand.afterFirstRead?.(server);
      return read;
    }
    const body = request.body as {
      expected_revision: number;
      preferences: { shortcuts: KeymapOverridesWire };
    };
    server.writes.push(body.preferences.shortcuts);
    const refusal = stand.refuse?.();
    if (refusal) return refusal;
    if (body.expected_revision !== server.revision) {
      return json(
        {
          error: "configuration changed since the revision this write expected",
          code: "config_conflict",
          current: config(),
        },
        { status: 409 },
      );
    }
    server.table = body.preferences.shortcuts;
    server.revision += 1;
    return json(config());
  });
  return server;
}

/// Wait for the write-back to end: a write that changes nothing queues
/// behind it on the window's one write chain. Its own read is left out of
/// the record.
async function writeBackEnded(server: Server): Promise<void> {
  await updateGlobalConfigSerial(() => null);
  server.requests.pop();
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

function sent(server: Server): string[] {
  return server.requests.map((request) => request.method);
}

afterEach(() => {
  hydrateOverrides(null);
  stopRecordingRequests();
  serveMeta("chan-settings-disabled", false);
  dismissStatus();
});

describe("a saved table that holds chords for removed commands", () => {
  test("this window resolves none of them and keeps every other row", async () => {
    const server = serve({ ...THEME, ...SEARCH });

    hydrateOverrides({ ...THEME, ...SEARCH });

    expect(overrideChordForSlot("app.theme.dark", "web")).toBeUndefined();
    expect(commandIdForChord("Mod+Alt+D")).toBeUndefined();
    expect(commandIdForChord("Mod+Alt+J")).toBe("app.search.toggle");
    expect(serializeOverrides()).toEqual(SEARCH);
    await writeBackEnded(server);
  });

  test("a focused terminal keeps the keystroke of a removed command's chord", async () => {
    const server = serve({});
    const press = (): KeyboardEvent =>
      new KeyboardEvent("keydown", {
        key: "j",
        altKey: true,
        ...(currentOS() === "mac" ? { metaKey: true } : { ctrlKey: true }),
      });

    hydrateOverrides({ "app.theme.dark": { web: "Mod+Alt+J" } });
    expect(shouldEscapeTerminal(press())).toBe(false);
    await writeBackEnded(server);

    // The same chord on a command the catalog holds leaves the terminal.
    hydrateOverrides({ "app.search.toggle": { web: "Mod+Alt+J" } });
    expect(shouldEscapeTerminal(press())).toBe(true);
  });

  test("the saved table is written back without them, and the status line says how many went", async () => {
    const server = serve({ ...THEME, ...SEARCH, ...SLIDE });

    hydrateOverrides({ ...THEME, ...SEARCH, ...SLIDE });
    await writeBackEnded(server);

    expect(sent(server)).toEqual(["GET", "PATCH"]);
    expect(server.writes).toEqual([SEARCH]);
    expect(server.table).toEqual(SEARCH);
    expect(ui.status).toBe("Dropped saved shortcuts for 2 removed commands");
    expect(ui.statusKind).toBe("transient");
  });

  test("one removed command is counted as one", async () => {
    const server = serve({ ...SLIDE });

    hydrateOverrides({ ...SLIDE });
    await writeBackEnded(server);

    expect(server.table).toEqual({});
    expect(ui.status).toBe("Dropped saved shortcuts for 1 removed command");
  });

  test("a table with no such row is left alone: nothing is sent and nothing is said", async () => {
    const server = serve({ ...SEARCH });

    hydrateOverrides({ ...SEARCH });
    await writeBackEnded(server);

    expect(sent(server)).toEqual([]);
    expect(ui.status).toBeNull();
  });

  test("an id the catalog does not hold is kept: an extension's, the shortcut table's own, and one nobody knows", async () => {
    // An extension registers its commands after the table loads, the
    // launcher's chord has no catalog row, and the last may be either.
    const unknown = {
      "extension.notes.capture": { web: "Mod+Alt+N" },
      "app.launcher.toggle": { web: "Mod+Alt+L" },
      "app.someday.maybe": { web: "Mod+Alt+M" },
    };
    const registered = new Set(allCommands().map((command) => command.id));
    for (const id of Object.keys(unknown)) expect(registered.has(id), id).toBe(false);
    const server = serve({ ...unknown, ...THEME });

    hydrateOverrides({ ...unknown, ...THEME });
    await writeBackEnded(server);

    expect(serializeOverrides()).toEqual(unknown);
    expect(server.table).toEqual(unknown);
    expect(ui.status).toBe("Dropped saved shortcuts for 1 removed command");
  });
});

describe("several windows that load the same saved table", () => {
  test("a window whose write lost to another's replays over the newer table, writes nothing and says nothing", async () => {
    const server = serve(
      { ...THEME, ...SEARCH },
      {
        afterFirstRead: (held) => {
          held.table = { ...SEARCH };
          held.revision += 1;
        },
      },
    );

    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);

    // The one write is the stale one the server refused.
    expect(sent(server)).toEqual(["GET", "PATCH"]);
    expect(server.revision).toBe(2);
    expect(server.table).toEqual(SEARCH);
    expect(ui.status).toBeNull();
  });

  test("a window that reads after another's write sends nothing and says nothing", async () => {
    // This window still holds the table as it was served before the write.
    const server = serve({ ...SEARCH });

    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);

    expect(sent(server)).toEqual(["GET"]);
    expect(ui.status).toBeNull();
    expect(serializeOverrides()).toEqual(SEARCH);
  });

  test("a chord another window assigned meanwhile survives the write-back", async () => {
    const graph = { "app.graph.toggle": { web: "Mod+Alt+G" } };
    const server = serve(
      { ...THEME, ...SEARCH },
      {
        afterFirstRead: (held) => {
          held.table = { ...held.table, ...graph };
          held.revision += 1;
        },
      },
    );

    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);

    expect(sent(server)).toEqual(["GET", "PATCH", "PATCH"]);
    expect(server.table).toEqual({ ...SEARCH, ...graph });
    expect(ui.status).toBe("Dropped saved shortcuts for 1 removed command");
  });

  test("the table loading again while the write is on its way starts no second write", async () => {
    const server = serve({ ...THEME, ...SEARCH });

    hydrateOverrides({ ...THEME, ...SEARCH });
    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);

    expect(sent(server)).toEqual(["GET", "PATCH"]);
    expect(server.table).toEqual(SEARCH);
  });
});

describe("a window that cannot write preferences", () => {
  test("resolves none of the removed commands, sends nothing and says nothing", async () => {
    serveMeta("chan-settings-disabled", true);
    const server = serve({ ...THEME, ...SEARCH });

    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);

    expect(sent(server)).toEqual([]);
    expect(ui.status).toBeNull();
    expect(serializeOverrides()).toEqual(SEARCH);
    expect(server.table).toEqual({ ...THEME, ...SEARCH });
  });

  test("a write the server refuses says nothing, and the next load tries again", async () => {
    let refusing = true;
    const server = serve(
      { ...THEME, ...SEARCH },
      { refuse: () => (refusing ? json({ error: "settings are disabled" }, { status: 403 }) : null) },
    );

    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);
    expect(sent(server)).toEqual(["GET", "PATCH"]);
    expect(ui.status).toBeNull();
    expect(server.table).toEqual({ ...THEME, ...SEARCH });

    refusing = false;
    hydrateOverrides({ ...THEME, ...SEARCH });
    await writeBackEnded(server);
    expect(server.table).toEqual(SEARCH);
    expect(ui.status).toBe("Dropped saved shortcuts for 1 removed command");
  });
});

describe("the retired list", () => {
  test("is the ids the catalog removed, family by family", () => {
    const surfaces = ["editor", "browser", "terminal", "graph", "dashboard"];
    const removed = [
      ...["system", "light", "dark"].map((theme) => `app.theme.${theme}`),
      ...surfaces.flatMap((surface) =>
        ["light", "dark"].map((theme) => `app.${surface}.surfaceTheme.${theme}`),
      ),
      ...["enable", "disable", "theme.plain", "theme.matrix"].map((row) => `app.screensaver.${row}`),
      ...["enable", "disable"].map((row) => `app.reports.${row}`),
      "app.semantic.enable",
      ...["bgeSmall", "bgeBase", "bgeLarge", "bgeM3"].map((model) => `app.semantic.model.${model}`),
      "app.terminal.backend.toggle",
      ...["settings", "closeTab", "reopenClosed"].map((row) => `app.browser.${row}`),
      ...["blue", "orange", "green", "pink", "grey"].map((colour) => `app.pane.focusColor.${colour}`),
      ...["tag", "contact", "language", "media", "markdown", "source"].map(
        (kind) => `app.graph.filter.${kind}`,
      ),
      ...["metrics", "workspace", "indexing", "about"].map((slide) => `app.dashboard.slide.${slide}`),
    ];
    expect(removed).toHaveLength(43);
    expect([...RETIRED_COMMAND_IDS].sort()).toEqual([...removed].sort());
  });

  test("names no command the catalog holds and no id of the shortcut table", () => {
    const live = new Set([
      ...allCommands().map((command) => command.id),
      ...SHORTCUTS.map((shortcut) => shortcut.id),
    ]);
    expect(live.size).toBeGreaterThan(100);
    expect([...RETIRED_COMMAND_IDS].filter((id) => live.has(id))).toEqual([]);
  });
});
