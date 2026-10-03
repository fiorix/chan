// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../../__tests__/settings";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;

describe("Settings > Terminal", () => {
  afterEach(closeSettings);

  test("TERM writes terminal.default_term once typing pauses and keeps the other terminal settings", async () => {
    const { target, writes } = await openSettings("Terminal");
    const term = target.querySelector<HTMLInputElement>('input[aria-label="Terminal TERM value"]')!;
    expect(term.value).toBe("xterm-256color");

    vi.useFakeTimers();
    try {
      for (const value of ["screen", "screen-256color"]) {
        term.value = value;
        term.dispatchEvent(new Event("input", { bubbles: true }));
        vi.advanceTimersByTime(300);
        await settleSettings();
      }
      expect(writes).toEqual([]);

      vi.advanceTimersByTime(100);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ terminal: { ...TERMINAL, default_term: "screen-256color" } });
  });

  test("MCP discovery writes terminal.mcp_env and keeps the other terminal settings", async () => {
    const { target, writes } = await openSettings("Terminal");
    const toggle = [...target.querySelectorAll<HTMLLabelElement>("label.pill")]
      .find((pill) => pill.textContent?.trim() === "Enable in new terminals")!
      .querySelector("input")!;

    toggle.click();
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ terminal: { ...TERMINAL, mcp_env: true } }));
  });
});
