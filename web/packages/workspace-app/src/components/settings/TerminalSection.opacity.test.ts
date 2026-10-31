// @vitest-environment jsdom
//
// The background opacity row of Settings > Terminal. The setting is
// chan-desktop's: in a desktop window the slider shows the desktop's value
// and a drag writes it through the host, never through the tenant's config
// route, whatever tenant the window shows; in a browser tab the row says so
// and keeps writing the tenant's preference, which the tab never paints.

import { afterEach, describe, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ desktop: false }));

vi.mock("../../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/desktop")>()),
  isTauriDesktop: () => host.desktop,
  writeTerminalBackgroundOpacity: vi.fn(async (percent: number) => percent),
}));

import { writeTerminalBackgroundOpacity } from "../../api/desktop";
import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../../__tests__/settings";
import {
  applyDesktopTerminalOpacity,
  desktopTerminalOpacity,
  resetDesktopTerminalOpacityForTests,
} from "../../terminal/desktopTerminalOpacity.svelte";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;

function row(target: HTMLElement): { slider: HTMLInputElement; hint: string; label: HTMLElement } {
  const slider = target.querySelector<HTMLInputElement>(
    'input[aria-label="Terminal background opacity percent"]',
  )!;
  const field = slider.closest<HTMLElement>(".field")!;
  return {
    slider,
    hint: field.querySelector(".hint")?.textContent?.trim() ?? "",
    label: field.querySelector<HTMLElement>(".value")!,
  };
}

/// Drag the slider to `percent` and let its debounce fire.
async function drag(slider: HTMLInputElement, percent: number): Promise<void> {
  vi.useFakeTimers();
  try {
    slider.value = String(percent);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
  } finally {
    vi.useRealTimers();
  }
}

describe("Settings > Terminal > Background opacity", () => {
  afterEach(() => {
    closeSettings();
    resetDesktopTerminalOpacityForTests();
    host.desktop = false;
    vi.mocked(writeTerminalBackgroundOpacity).mockClear();
  });

  test("in a chan-desktop window the slider shows the desktop's value and a drag writes it through the host", async () => {
    host.desktop = true;
    applyDesktopTerminalOpacity(85);
    // The tenant this window shows says 100; the row must not read it.
    const { target, writes } = await openSettings("Terminal");
    const { slider, hint } = row(target);
    expect(slider.value, "the desktop's value, not the tenant's").toBe("85");
    expect(hint).toContain("every chan-desktop window");
    expect(hint).toContain("chan-desktop's own setting");

    await drag(slider, 90);
    await vi.waitFor(() => expect(writeTerminalBackgroundOpacity).toHaveBeenCalledWith(90));
    await settleSettings();
    expect(desktopTerminalOpacity()).toBe(90);
    expect(writes, "no PATCH of the tenant's config").toEqual([]);
    expect(row(target).label.classList.contains("saved"), "the field lit for the write").toBe(true);
  });

  test("in a browser tab the row says the setting applies in chan-desktop and keeps writing the tenant's preference", async () => {
    // A value the store would only hold in a desktop window: the tab must
    // show the tenant's preference, not this.
    applyDesktopTerminalOpacity(85);
    const { target, writes } = await openSettings("Terminal");
    const { slider, hint } = row(target);
    expect(slider.value).toBe("100");
    expect(hint).toContain("Applies in chan-desktop");
    expect(hint).toContain("a browser tab stays opaque");

    await drag(slider, 90);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ terminal: { ...TERMINAL, background_opacity: 90 } });
    expect(writeTerminalBackgroundOpacity).not.toHaveBeenCalled();
  });
});
