// @vitest-environment jsdom
//
// Custom terminal colours are one preference, sent whole. The config route
// refuses the whole palette when any of its three hexes does not parse as
// `#rgb` or `#rrggbb`, while the file on disk can hold anything a hand edit
// put there. A write copies the stored palette, so it must send each stored
// hex in the form the route accepts, and the standard colour in place of one
// that does not parse, which is what the terminal paints for such a palette.

import { afterEach, describe, expect, test, vi } from "vitest";

import { closeSettings, openSettings, settingsPreferences } from "../../__tests__/settings";

// jsdom defines no theme tokens, so the standard colours are the reader's
// fallbacks.
const STANDARD = { background: "#1c1c1e", foreground: "#ebebf0", cursor: "#58a6ff" };

function storedPalette(): Record<string, unknown> {
  return {
    ...settingsPreferences(),
    terminal_colors: {
      mode: "custom",
      custom: { background: "zzz", foreground: "fff", cursor: "#00ff00", contrast: "auto" },
    },
  };
}

describe("Settings > Terminal > custom colours over a hand-edited palette", () => {
  afterEach(closeSettings);

  test("an edit sends every stored hex in the form the route accepts", async () => {
    const { target, writes } = await openSettings("Terminal", storedPalette());
    const swatch = target.querySelector<HTMLInputElement>('input[aria-label="Cursor colour swatch"]')!;
    swatch.value = "#ff0000";
    swatch.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      terminal_colors: {
        mode: "custom",
        custom: { background: STANDARD.background, foreground: "#ffffff", cursor: "#ff0000", contrast: "auto" },
      },
    });
  });

  test("turning custom colours off keeps a palette the route accepts", async () => {
    const { target, writes } = await openSettings("Terminal", storedPalette());
    const toggle = [...target.querySelectorAll<HTMLLabelElement>("label.pill")]
      .find((label) => label.textContent?.trim() === "Custom terminal colours")!
      .querySelector("input")!;
    toggle.click();

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      terminal_colors: {
        mode: "standard",
        custom: { background: STANDARD.background, foreground: "#ffffff", cursor: "#00ff00", contrast: "auto" },
      },
    });
  });
});
