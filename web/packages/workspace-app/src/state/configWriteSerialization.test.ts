// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import clientSource from "../api/client.ts?raw";
import preferenceWriteSource from "../api/preferenceWrite.ts?raw";
import storeSource from "./store.svelte.ts?raw";
import configWriteSource from "./configWrite.ts?raw";
import editorToolsSource from "./editorTools.svelte.ts?raw";
import { updateGlobalConfigSerial } from "./store.svelte";

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

describe("all config writers share one helper", () => {
  test("the state import point re-exports the API helper", () => {
    expect(configWriteSource).toMatch(
      /export \{ updateGlobalConfigSerial \} from "\.\.\/api\/preferenceWrite";/,
    );
    expect(preferenceWriteSource).toMatch(
      /export function updateGlobalConfigSerial\(/,
    );
    expect(clientSource).not.toMatch(/queuePrefWrite|prefsWriteInflight/);
  });

  test("store writers return partial field patches", () => {
    expect(storeSource).toMatch(
      /persistHybridSurfaceThemes\(\)[\s\S]*?\(\) => \(\{ hybrid_surface_themes: next \}\)/,
    );
    expect(storeSource).toMatch(
      /persistThemeChoice\([\s\S]*?\{ theme: choice \}/,
    );
    expect(storeSource).toMatch(/return \{ pane_widths: snapshot \};/);
    expect(storeSource).not.toMatch(
      /dateFormatPersistInflight|sidePanesPersistInflight/,
    );
  });

  test("editorTools uses the shared partial writer", () => {
    expect(editorToolsSource).toMatch(
      /import \{ updateGlobalConfigSerial \} from "\.\/configWrite";/,
    );
    expect(editorToolsSource).toMatch(
      /\{ strip_trailing_whitespace_on_save: value \}/,
    );
  });
});
