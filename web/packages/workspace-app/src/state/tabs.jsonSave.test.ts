// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { closeTab, isDirty, scheduleAutosave } from "./tabs.svelte";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetLayout([]);
});

// What a typo in source mode leaves: a trailing comma.
const BROKEN = '{ "name": "chan", }';

/// A tab in source mode with no live session, holding `content` over what
/// was last saved, with its writes recorded.
function sourceTab(path: string, content: string) {
  const initial = fileTab({ path, mode: "source", content, saved: "{}" });
  const pane = resetLayout([initial]);
  const tab = readTab(initial.id)!;
  const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
  return { pane, tab, write };
}

async function autosave(paneId: string, tabId: string) {
  vi.useFakeTimers();
  scheduleAutosave(paneId, tabId);
  await vi.advanceTimersByTimeAsync(900);
}

describe("a .json buffer is saved as typed", () => {
  test("a buffer that does not parse is written as typed and the tab has no error", async () => {
    const { pane, tab, write } = sourceTab("data/config.json", BROKEN);
    await autosave(pane.id, tab.id);

    expect({ written: write.mock.calls.map((call) => [call[0], call[1]]), error: tab.error, dirty: isDirty(tab) }).toEqual({
      written: [["data/config.json", BROKEN]], error: null, dirty: false,
    });
  });

  test("a close of a dirty tab whose buffer does not parse saves it and closes it", async () => {
    const { pane, tab, write } = sourceTab("data/config.json", BROKEN);
    await closeTab(pane.id, tab.id);

    expect({ written: write.mock.calls.map((call) => [call[0], call[1]]), open: readTab(tab.id) !== undefined }).toEqual({
      written: [["data/config.json", BROKEN]], open: false,
    });
  });

  test("a buffer that parses is written as typed", async () => {
    const typed = '{ "name":   "chan" }\n';
    const { pane, tab, write } = sourceTab("data/config.json", typed);
    await autosave(pane.id, tab.id);

    expect({ written: write.mock.calls.map((call) => [call[0], call[1]]), error: tab.error, dirty: isDirty(tab) }).toEqual({
      written: [["data/config.json", typed]], error: null, dirty: false,
    });
  });
});

describe("a drawing in source mode keeps the parse check", () => {
  test("a buffer that does not parse is not written and the tab says why", async () => {
    const { pane, tab, write } = sourceTab("notes/board.excalidraw", BROKEN);
    await autosave(pane.id, tab.id);

    expect({ writes: write.mock.calls.length, error: tab.error, saveError: tab.saveError?.startsWith("the drawing does not parse ("), dirty: isDirty(tab) }).toEqual({
      writes: 0, error: null, saveError: true, dirty: true,
    });
  });
});
