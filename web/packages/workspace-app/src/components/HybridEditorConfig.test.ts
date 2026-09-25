// @vitest-environment jsdom
//
// The Hybrid Editor back card is the shared shell and nothing else: its title
// and an OK that hands back to the pane. It renders no control and sends no
// request. The editor's settings live in Settings > Editor, which writes each
// one to the global config on its own: line spacing, date format and
// strip-on-save here (the editor theme and the editor's body theme are driven
// in SettingsOverlay.render.test.ts).

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DATE_FORMATS } from "../editor/dateFormats";
import { recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import { closeSettings, openSettings } from "../__tests__/settings";
import HybridEditorConfig from "./HybridEditorConfig.svelte";

describe("the Hybrid Editor back card", () => {
  afterEach(() => {
    stopRecordingRequests();
    document.body.innerHTML = "";
  });

  test("shows its title and no control, sends nothing, and hands back on OK", () => {
    const requests = recordRequests();
    const onDone = vi.fn();
    const target = document.createElement("div");
    document.body.append(target);
    const view = mount(HybridEditorConfig, { target, props: { onDone } });
    try {
      flushSync();
      const card = target.querySelector<HTMLElement>('[aria-label="Hybrid Editor configuration"]')!;
      expect(card.querySelector("h2")?.textContent).toBe("Hybrid Editor");
      expect(card.querySelectorAll("input, select, textarea")).toHaveLength(0);

      card.querySelector<HTMLButtonElement>(".config-ok")!.click();
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(requests).toEqual([]);
    } finally {
      unmount(view);
    }
  });
});

describe("Settings > Editor", () => {
  afterEach(closeSettings);

  test("line spacing writes line_spacing alone", async () => {
    const { target, writes } = await openSettings("Editor");

    target.querySelector<HTMLInputElement>('input[name="settings-line-spacing"][value="compact"]')!.click();
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ line_spacing: "compact" }));
  });

  describe("the date format", () => {
    function dateFormatSelect(target: HTMLElement): HTMLSelectElement | undefined {
      return [...target.querySelectorAll<HTMLSelectElement>("select")].find((candidate) =>
        [...candidate.options].some((option) => option.value === DATE_FORMATS[1]!.id),
      );
    }

    function choose(select: HTMLSelectElement, id: string): void {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // What the expected failure below takes for granted, checked where a
    // failure counts: the select is there and a choice reaches the write's
    // config read.
    test("offers each format, and a choice asks for the config to write into", async () => {
      const { target, requests } = await openSettings("Editor");
      const select = dateFormatSelect(target);
      expect(select, "the date format select").toBeDefined();
      expect([...select!.options].map((option) => option.value)).toEqual(DATE_FORMATS.map((format) => format.id));
      const before = requests.length;

      choose(select!, DATE_FORMATS[1]!.id);

      await vi.waitFor(() =>
        expect(requests.slice(before)).toContainEqual(expect.objectContaining({ method: "GET", path: "/api/config" })),
      );
    });

    // The select reads its value off the change event inside the write, which
    // runs after the event has finished and its currentTarget is null, so the
    // write is refused and the field goes back to the stored format. This test
    // states what the select should do and fails until that read moves out of
    // the write.
    test.fails("writes date_format alone", async () => {
      const { target, writes } = await openSettings("Editor");

      choose(dateFormatSelect(target)!, DATE_FORMATS[1]!.id);

      await vi.waitFor(() => expect(writes.at(-1)).toEqual({ date_format: DATE_FORMATS[1]!.id }));
    });
  });

  test("Strip on save writes strip_trailing_whitespace_on_save alone", async () => {
    const { target, writes } = await openSettings("Editor");
    const toggle = [...target.querySelectorAll<HTMLLabelElement>("label.pill")]
      .find((pill) => pill.textContent?.trim() === "Strip on save")!
      .querySelector("input")!;

    toggle.click();
    await vi.waitFor(() => expect(writes.at(-1)).toEqual({ strip_trailing_whitespace_on_save: true }));
  });
});
