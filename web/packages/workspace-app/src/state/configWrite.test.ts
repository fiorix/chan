// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as preferenceWrite from "../api/preferenceWrite";
import * as configWrite from "./configWrite";
import { persistStripTrailingWhitespaceOnSave } from "./editorTools.svelte";
import {
  clearHybridSurfaceTheme,
  paneWidths,
  persistPaneWidths,
  setHybridSurfaceTheme,
  setThemeChoice,
  updateGlobalConfigSerial,
} from "./store.svelte";

type Cfg = {
  revision: number;
  preferences: Record<string, unknown>;
  workspaces: unknown[];
};

let server: Cfg;
let forcedConflicts: number;
let patchBodies: Array<{
  expected_revision: number;
  preferences: Record<string, unknown>;
}>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  server = {
    revision: 1,
    preferences: {
      theme: "dark",
      date_format: "iso",
      terminal: { default_term: "xterm-256color" },
    },
    workspaces: [],
  };
  forcedConflicts = 0;
  patchBodies = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (!url.includes("/api/config")) return new Response(null, { status: 404 });
    if (method !== "PATCH") return jsonResponse(server);

    const body = JSON.parse(String(init?.body)) as {
      expected_revision: number;
      preferences: Record<string, unknown>;
    };
    patchBodies.push(body);
    if (forcedConflicts > 0) {
      forcedConflicts--;
      server = {
        ...server,
        revision: server.revision + 1,
        preferences: { ...server.preferences, theme: "light" },
      };
      return jsonResponse(
        { error: "config_conflict", current: server },
        409,
      );
    }
    if (body.expected_revision !== server.revision) {
      return jsonResponse(
        { error: "config_conflict", current: server },
        409,
      );
    }
    server = {
      ...server,
      revision: server.revision + 1,
      preferences: { ...server.preferences, ...body.preferences },
    };
    return jsonResponse(server);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("revisioned partial config writes", () => {
  test("concurrent writes send narrow patches and both survive", async () => {
    await Promise.all([
      updateGlobalConfigSerial((prefs) =>
        prefs.theme === "light" ? null : { theme: "light" },
      ),
      updateGlobalConfigSerial((prefs) => ({
        terminal: { ...prefs.terminal, default_term: "tmux-256color" },
      })),
    ]);

    expect(server.preferences.theme).toBe("light");
    expect(
      (server.preferences.terminal as { default_term: string }).default_term,
    ).toBe("tmux-256color");
    expect(patchBodies.map((body) => Object.keys(body.preferences))).toEqual([
      ["theme"],
      ["terminal"],
    ]);
  });

  test("a conflict reapplies the original mutation to current preferences", async () => {
    forcedConflicts = 1;
    await updateGlobalConfigSerial((prefs) =>
      prefs.date_format === "us" ? null : { date_format: "us" },
    );

    expect(patchBodies).toHaveLength(2);
    expect(patchBodies[0]?.expected_revision).toBe(1);
    expect(patchBodies[1]?.expected_revision).toBe(2);
    expect(server.preferences.theme).toBe("light");
    expect(server.preferences.date_format).toBe("us");
  });

  test("the fourth conflict is surfaced after three retries", async () => {
    forcedConflicts = 4;
    await expect(
      updateGlobalConfigSerial(() => ({ date_format: "us" })),
    ).rejects.toMatchObject({ status: 409 });
    expect(patchBodies).toHaveLength(4);
  });

  test("a mutation returning null skips the PATCH", async () => {
    await updateGlobalConfigSerial(() => null);
    expect(patchBodies).toHaveLength(0);
  });
});

describe("every config writer patches only its own field through one helper", () => {
  test("the state import point and the store hand out the api helper itself", () => {
    expect(configWrite.updateGlobalConfigSerial).toBe(preferenceWrite.updateGlobalConfigSerial);
    expect(updateGlobalConfigSerial).toBe(preferenceWrite.updateGlobalConfigSerial);
  });

  // The surface-theme writer builds its body inside the mutation, so what
  // matters is the body it sends.
  test("a surface-theme write patches only its own field", async () => {
    await setHybridSurfaceTheme("editor", "dark");
    expect(patchBodies).toHaveLength(1);
    expect(Object.keys(patchBodies[0]!.preferences)).toEqual([
      "hybrid_surface_themes",
    ]);
    expect(patchBodies[0]!.preferences.hybrid_surface_themes).toEqual({
      editor: "dark",
    });
    await clearHybridSurfaceTheme("editor");
  });

  test("a theme choice patches only the theme, and not at all when unchanged", async () => {
    await setThemeChoice("light");
    await setThemeChoice("light");
    expect(patchBodies.map((body) => body.preferences)).toEqual([{ theme: "light" }]);
  });

  test("pane widths patch only pane_widths once the resize settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    paneWidths.inspector = 410;
    persistPaneWidths();
    persistPaneWidths();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(Object.keys(patchBodies[0]!.preferences)).toEqual(["pane_widths"]);
    expect(patchBodies[0]!.preferences.pane_widths).toMatchObject({ inspector: 410 });
  });

  test("strip-trailing-whitespace patches only its own field", async () => {
    await persistStripTrailingWhitespaceOnSave(true);
    expect(patchBodies.map((body) => body.preferences)).toEqual([
      { strip_trailing_whitespace_on_save: true },
    ]);
  });
});
