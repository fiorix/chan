// @vitest-environment jsdom
//
// The terminal font is chosen in Settings > Terminal, from OS default (mono)
// and Source Code Pro. The face ships with chan, so choosing it is a plain
// write of terminal.font, with nothing to download first. It is chosen there
// only: the Dashboard's About slide names no font and offers no font control.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { closeSettings, openSettings, settingsPreferences, settleSettings } from "../../__tests__/settings";
import EmptyPaneCarousel from "../EmptyPaneCarousel.svelte";

const TERMINAL = settingsPreferences().terminal as Record<string, unknown>;

describe("Settings > Terminal > Terminal font", () => {
  afterEach(closeSettings);

  test("offers OS default (mono) and Source Code Pro", async () => {
    const { target } = await openSettings("Terminal");
    const select = target.querySelector<HTMLSelectElement>('select[aria-label="Terminal font"]')!;

    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["os-default", "OS default (mono)"],
      ["source-code-pro", "Source Code Pro"],
    ]);
  });

  test("choosing Source Code Pro writes terminal.font and fetches nothing but the config", async () => {
    const { target, writes, requests } = await openSettings("Terminal");
    const before = requests.length;
    const select = target.querySelector<HTMLSelectElement>('select[aria-label="Terminal font"]')!;

    select.value = "source-code-pro";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(writes).toEqual([{ terminal: { ...TERMINAL, font: "source-code-pro" } }]));
    await settleSettings();
    expect(new Set(requests.slice(before).map(({ path }) => path))).toEqual(new Set(["/api/config"]));
  });
});

describe("the Dashboard's About slide", () => {
  test("names no terminal font and offers no font control", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const view = mount(EmptyPaneCarousel, { target, props: { slide: 2 } });
    try {
      flushSync();
      const about = target.querySelector<HTMLElement>('.slide-about[aria-label="About"]')!;
      expect(about.textContent).not.toContain("Source Code Pro");
      expect(about.querySelectorAll("select, input")).toHaveLength(0);
    } finally {
      unmount(view);
      target.remove();
    }
  });
});
