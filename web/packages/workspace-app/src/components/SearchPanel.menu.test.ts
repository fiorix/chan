// @vitest-environment jsdom
//
// The search panel's menu: Details, the launcher's toggle for the panel's
// Details pane, drawn as its command's title with a check, then Search
// again, which runs the panel's own query once more and keeps its own words.
// The row and the command are one switch, whichever flips it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, searchContent: vi.fn(), list: vi.fn(), reportFile: vi.fn() } };
});
vi.mock("../state/graphData.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/graphData.svelte")>()),
  ensureGraphLoaded: vi.fn(async () => {}),
}));

import SearchPanel from "./SearchPanel.svelte";
import { api } from "../api/client";
import type { ContentSearchResponse } from "../api/types";
import { expectWords } from "../__tests__/menuWords";
import { installEditorDom } from "../__tests__/wysiwyg";
import { commandById, commandState } from "../state/commands";
import { searchPanel } from "../state/store.svelte";

installEditorDom();

const EMPTY: ContentSearchResponse = { ready: true, readiness: { state: "ready" }, mode: "bm25", hits: [] };
let component: ReturnType<typeof mount>;
let target: HTMLElement;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(api.searchContent).mockResolvedValue(EMPTY);
  vi.mocked(api.list).mockResolvedValue([]);
  searchPanel.open = true;
  searchPanel.query = "";
  searchPanel.inspectorOpen = false;
  target = document.createElement("div");
  document.body.append(target);
  component = mount(SearchPanel, { target });
  await flush();
});

afterEach(() => {
  unmount(component);
  searchPanel.open = false;
  searchPanel.query = "";
  searchPanel.inspectorOpen = false;
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function openMenu(): Promise<HTMLButtonElement[]> {
  document.body
    .querySelector(".search")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await flush();
  return [...document.body.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")];
}

function label(button: HTMLButtonElement): string {
  return button.querySelector(".menu-row-label")!.textContent!.trim();
}

describe("the search panel's menu", () => {
  test("words Details by its command and keeps its own words for running the search again", async () => {
    const rows = await openMenu();

    expectWords(rows.map(label), [
      { command: "app.search.details" },
      {
        own: "Search again",
        because: "runs the open panel's own query once more; nothing outside the panel can ask for it",
      },
    ]);
    expect(rows.map(label)).not.toContain(commandById("app.window.reload")!.title);
  });

  test("draws Details as a check that follows the command's state", async () => {
    let [details] = await openMenu();
    expect(details!.getAttribute("role")).toBe("menuitemcheckbox");
    expect(details!.getAttribute("aria-checked")).toBe("false");

    details!.click();
    await flush();
    expect(searchPanel.inspectorOpen).toBe(true);
    expect(commandState("app.search.details")).toBe(true);
    expect(document.body.querySelector(".hamburger-menu"), "the row closes the menu").toBeNull();

    [details] = await openMenu();
    expect(details!.getAttribute("aria-checked")).toBe("true");
  });

  test("the command flips the pane the row shows", async () => {
    commandById("app.search.details")!.run();
    await flush();

    expect(document.body.querySelector("aside.inspector"), "the Details pane").not.toBeNull();
    const [details] = await openMenu();
    expect(details!.getAttribute("aria-checked")).toBe("true");
  });

  test("Search again asks the server for the query's hits once more", async () => {
    const input = document.body.querySelector<HTMLInputElement>(".search input")!;
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.runOnlyPendingTimersAsync();
    await flush();
    const before = vi.mocked(api.searchContent).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    const rows = await openMenu();
    rows.find((button) => label(button) === "Search again")!.click();
    await vi.runOnlyPendingTimersAsync();
    await flush();

    expect(vi.mocked(api.searchContent).mock.calls.length).toBeGreaterThan(before);
  });
});
