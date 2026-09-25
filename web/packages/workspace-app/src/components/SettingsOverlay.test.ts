// @vitest-environment jsdom
//
// Settings writes each change as a patch of only the field it changed, against
// the revision of the config it read, and on a conflict takes the config the
// server sent back and replays the change on top of it, so a change made
// elsewhere in the meantime survives. The theme goes through the app's own
// theme setter, so the chrome follows before the write lands. A size field
// commits on Enter (on blur in SettingsOverlay.render.test.ts). Secret
// masking offers its toggle, scoped to xterm.js terminals, and shows its
// suffixes read-only.

import { afterEach, describe, expect, test, vi } from "vitest";

import { json, recordRequests, type RecordedRequest } from "../__tests__/fetch";
import { closeSettings, openSettings, settingsPreferences } from "../__tests__/settings";
import { ui } from "../state/store.svelte";

afterEach(closeSettings);

function patches(requests: RecordedRequest[]): unknown[] {
  return requests.filter((request) => request.method === "PATCH").map((request) => request.body);
}

function pill(target: HTMLElement, name: string, value: string): HTMLInputElement {
  return target.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
}

describe("a settings write", () => {
  test("patches only the changed field against the revision it read", async () => {
    const { target, requests } = await openSettings("Editor");

    pill(target, "settings-line-spacing", "compact").click();

    await vi.waitFor(() =>
      expect(patches(requests)).toEqual([{ expected_revision: 1, preferences: { line_spacing: "compact" } }]),
    );
  });

  test("replays its change on the config a conflict sends back, keeping the other change", async () => {
    const { target } = await openSettings("Editor");
    // The write reads revision 1; another window's editor_theme change lands
    // as revision 2 before its PATCH arrives.
    let stored: Record<string, unknown> = settingsPreferences();
    let revision = 1;
    const sent = recordRequests((request) => {
      if (request.method !== "PATCH") {
        const read = json({ revision, preferences: stored, workspaces: [] });
        stored = { ...stored, editor_theme: "word" };
        revision = 2;
        return read;
      }
      const body = request.body as { expected_revision: number; preferences: Record<string, unknown> };
      if (body.expected_revision !== revision) {
        return json(
          { error: "config_conflict", current: { revision, preferences: stored, workspaces: [] } },
          { status: 409 },
        );
      }
      stored = { ...stored, ...body.preferences };
      revision += 1;
      return json({ revision, preferences: stored, workspaces: [] });
    });

    pill(target, "settings-line-spacing", "compact").click();

    await vi.waitFor(() => expect(stored.line_spacing).toBe("compact"));
    expect(stored.editor_theme).toBe("word");
    expect(patches(sent)).toEqual([
      { expected_revision: 1, preferences: { line_spacing: "compact" } },
      { expected_revision: 2, preferences: { line_spacing: "compact" } },
    ]);
  });
});

describe("the theme", () => {
  test("re-skins the app at once and writes the choice", async () => {
    const { target, writes } = await openSettings("Global");

    pill(target, "settings-theme", "dark").click();

    expect(ui.themeChoice).toBe("dark");
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ theme: "dark" }));
  });
});

describe("a size field", () => {
  test("commits on Enter", async () => {
    const { target, writes } = await openSettings("Terminal");
    const size = target.querySelector<HTMLInputElement>('input[aria-label="Terminal font size"]')!;

    size.value = "18";
    size.dispatchEvent(new Event("input", { bubbles: true }));
    size.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(writes.at(-1)).toEqual({
        terminal: { ...(settingsPreferences().terminal as Record<string, unknown>), font_size: 18 },
      }),
    );
  });
});

describe("secret masking", () => {
  test("offers its toggle, scoped to xterm.js terminals, and shows the suffixes read-only", async () => {
    const { target } = await openSettings("Terminal");
    const field = [...target.querySelectorAll<HTMLElement>("h3")]
      .find((heading) => heading.textContent === "Secret masking")!
      .closest<HTMLElement>("section.field")!;

    expect(field.textContent).toContain("xterm.js terminals only");
    expect(field.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const suffixes = field.querySelector('[aria-label="Secret mask suffixes"]')!;
    expect(suffixes.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(suffixes.querySelector("button")).toBeNull();
  });
});
