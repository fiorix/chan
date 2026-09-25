// @vitest-environment jsdom
//
// The Hybrid Terminal back card is the shared shell and nothing else: its
// title and an OK that hands back to the pane. It renders no control and
// sends no request. The terminal's settings live in Settings > Terminal,
// which writes each one into the terminal preferences and keeps the others:
// TERM, written once typing pauses, and MCP discovery here (scrollback,
// mouse capture and the font are
// driven in SettingsOverlay.render.test.ts and TerminalSection.font.test.ts).

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../__tests__/settings";
import HybridTerminalConfig from "./HybridTerminalConfig.svelte";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;

describe("the Hybrid Terminal back card", () => {
  afterEach(() => {
    stopRecordingRequests();
    document.body.innerHTML = "";
  });

  test("shows its title and no control, sends nothing, and hands back on OK", () => {
    const requests = recordRequests();
    const onDone = vi.fn();
    const target = document.createElement("div");
    document.body.append(target);
    const view = mount(HybridTerminalConfig, { target, props: { onDone } });
    try {
      flushSync();
      const card = target.querySelector<HTMLElement>('[aria-label="Hybrid Terminal configuration"]')!;
      expect(card.querySelector("h2")?.textContent).toBe("Hybrid Terminal");
      expect(card.querySelectorAll("input, select, textarea")).toHaveLength(0);

      card.querySelector<HTMLButtonElement>(".config-ok")!.click();
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([]);
    } finally {
      unmount(view);
    }
  });
});

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
