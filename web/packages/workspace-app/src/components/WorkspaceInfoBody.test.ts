// @vitest-environment jsdom
//
// WorkspaceInfoBody, mounted. The workspace inspector reads the tree store,
// the report api and the shared graph snapshot; the store and the api are
// stubbed so each test sets what the body sees and reads what it renders and
// calls.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
import type { GraphView, ReportPrefix } from "../api/types";
import { graphData, invalidateGraph } from "../state/graphData.svelte";
import { ApiError } from "../api/errors";
import { terminalFromHereTarget } from "../terminal/fromHere";

const h = vi.hoisted(() => ({
  caps: { workspace: true, files: true, drafts: true, terminal: true },
  report: null as unknown,
  reportFails404: false,
}));

vi.mock("../state/windowCaps", () => ({ windowCaps: h.caps }));

vi.mock("../api/client", () => ({
  api: {
    inspector: vi.fn(async () => null),
    reportDir: vi.fn(async () => {
      if (h.reportFails404) throw new ApiError(404, "directory report not found", {
        error: "directory report not found", code: "report_not_found",
      });
      return h.report;
    }),
    reportPrefix: vi.fn(async () => h.report),
    graphStream: vi.fn(async () => ({ nodes: [], edges: [] })),
  },
  withTokenQuery: (u: string) => u,
}));

vi.mock("../state/store.svelte", () => ({
  fileOps: {
    uploadFilesTo: vi.fn(async () => {}),
    downloadPathWithProgress: vi.fn(),
  },
  openGraphAtNode: vi.fn(),
  openGraphForContact: vi.fn(),
  openGraphForLanguage: vi.fn(),
  revealPathInBrowser: vi.fn(),
  tree: { entries: [], loadingDirs: {}, loadedDirs: {}, dirErrors: {} },
  workspace: { info: { root: "/home/me/ws", label: "ws" } },
}));

vi.mock("../state/tabs.svelte", () => ({ openTerminalInActivePane: vi.fn() }));

import { api } from "../api/client";
import {
  fileOps,
  openGraphAtNode,
  openGraphForContact,
  openGraphForLanguage,
  revealPathInBrowser,
} from "../state/store.svelte";
import { openTerminalInActivePane } from "../state/tabs.svelte";

type Props = {
  variant?: "inspector" | "dashboard";
  onReveal?: () => void;
  onSetAsScope?: () => void;
  onLanguageClick?: (language: string) => void;
  onContactNavigate?: (path: string) => void;
};

const mounted: Array<Record<string, unknown>> = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function render(props: Props = {}): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(WorkspaceInfoBody, { target, props }));
  await settle();
  return target;
}

function menu(target: HTMLElement): string[] {
  target.querySelector<HTMLButtonElement>(".pill-caret")!.click();
  flushSync();
  return [...target.querySelectorAll(".action-menu-item")].map((b) => b.textContent?.trim() ?? "");
}

function menuItem(target: HTMLElement, label: string): HTMLButtonElement {
  const item = [...target.querySelectorAll<HTMLButtonElement>(".action-menu-item")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

const prefix: ReportPrefix = {
  totals: { files: 3, code: 300, comments: 20, blanks: 10, complexity: 9 },
  by_language: [
    { name: "Rust", files: 2, code: 250, comments: 15, blanks: 8, complexity: 7 },
    { name: "TOML", files: 1, code: 50, comments: 5, blanks: 2, complexity: 2 },
  ],
  cocomo: {
    model: "organic",
    effort_person_months: 1.2,
    schedule_months: 2.3,
    developers: 0.5,
    estimated_cost_usd: 1000,
  },
};

beforeEach(() => {
  // A loaded graph, so the body's ensureGraphLoaded has nothing to fetch.
  graphData.view = { nodes: [], edges: [] };
  h.caps.workspace = true;
  h.report = null;
  h.reportFails404 = false;
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  graphData.view = null;
  vi.clearAllMocks();
});

describe("the workspace root's actions", () => {
  test("lead with Open, and offer upload, download and a terminal behind the caret", async () => {
    const target = await render();
    expect(target.querySelector(".pill-main")?.textContent?.trim()).toBe("Open");
    expect(menu(target)).toEqual(["Upload file here", "Download tarball", "New terminal here"]);
  });

  test("add Graph from here only when the host can scope a graph", async () => {
    const onSetAsScope = vi.fn();
    const target = await render({ onSetAsScope });
    expect(menu(target)).toContain("Graph from here");
    menuItem(target, "Graph from here").click();
    expect(onSetAsScope).toHaveBeenCalledTimes(1);
  });

  test("Open hands off to the host, or reveals the root in a new File Browser tab", async () => {
    const onReveal = vi.fn();
    const first = await render({ onReveal });
    first.querySelector<HTMLButtonElement>(".pill-main")!.click();
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(revealPathInBrowser).not.toHaveBeenCalled();

    const second = await render();
    second.querySelector<HTMLButtonElement>(".pill-main")!.click();
    expect(revealPathInBrowser).toHaveBeenCalledWith("", { enter: true, inspectorOpen: true });
  });

  test("upload, download and the terminal all act on the root", async () => {
    const target = await render();
    const picker = target.querySelector<HTMLInputElement>("input[type='file']")!;
    const pick = vi.spyOn(picker, "click").mockImplementation(() => {});

    menu(target);
    menuItem(target, "Upload file here").click();
    expect(pick).toHaveBeenCalledTimes(1);
    const files = [new File(["x"], "x.txt")];
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(fileOps.uploadFilesTo).toHaveBeenCalledWith("", files);

    menu(target);
    menuItem(target, "Download tarball").click();
    expect(fileOps.downloadPathWithProgress).toHaveBeenCalledWith("", true);

    menu(target);
    menuItem(target, "New terminal here").click();
    expect(openTerminalInActivePane).toHaveBeenCalledWith(terminalFromHereTarget("", true));
  });

  test("the dashboard variant has no action row", async () => {
    const target = await render({ variant: "dashboard" });
    expect(target.querySelector(".actions-section")).toBeNull();
    expect(target.querySelector(".pill-main")).toBeNull();
  });
});

describe("the languages report", () => {
  test("prefers the directory cache and falls back to the walk on report_not_found", async () => {
    h.report = prefix;
    await render();
    expect(api.reportDir).toHaveBeenCalledWith("");
    expect(api.reportPrefix).not.toHaveBeenCalled();
    unmount(mounted.pop()!);

    h.reportFails404 = true;
    const target = await render();
    expect(api.reportPrefix).toHaveBeenCalledWith("");
    expect(target.querySelectorAll("button.lang-name")).toHaveLength(2);
  });

  test("falls back on report_not_found through the real transport", async () => {
    const real = await vi.importActual<typeof import("../api/client")>("../api/client");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "The cached directory report is unavailable.", code: "report_not_found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    h.report = prefix;
    vi.mocked(api.reportDir).mockImplementationOnce(real.api.reportDir);
    vi.mocked(api.reportPrefix).mockResolvedValueOnce(prefix);
    try {
      const target = await render();
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/report/dir?path="),
        expect.objectContaining({ method: "GET" }));
      expect(api.reportPrefix).toHaveBeenCalledWith("");
      expect(target.querySelectorAll("button.lang-name")).toHaveLength(2);
    } finally {
      fetch.mockRestore();
    }
  });

  test.each([
    ["a plain Error", new Error("404 not found")],
    ["an ApiError without a code", new ApiError(404, "404 not found")],
    ["another code", new ApiError(404, "404 not found", { code: "other" })],
    ["another status", new ApiError(500, "404 not found", { code: "report_not_found" })],
  ])("shows the refusal without a walk for %s", async (_reason, error) => {
    h.report = prefix;
    vi.mocked(api.reportDir).mockRejectedValueOnce(error);
    const target = await render();
    expect(target.querySelector(".refs-error")?.textContent).toBe("report unavailable: 404 not found");
    expect(api.reportPrefix).not.toHaveBeenCalled();
  });

  test("each language opens the graph scoped to it, through the host when it asks", async () => {
    h.report = prefix;
    const first = await render();
    const rows = [...first.querySelectorAll<HTMLButtonElement>("button.lang-name")];
    expect(rows.map((b) => b.textContent?.trim())).toEqual(["Rust", "TOML"]);
    expect(rows[0]!.title).toBe("open in graph (scoped to this language)");
    rows[1]!.click();
    expect(openGraphForLanguage).toHaveBeenCalledWith("TOML");

    const onLanguageClick = vi.fn();
    const second = await render({ onLanguageClick });
    second.querySelector<HTMLButtonElement>("button.lang-name")!.click();
    expect(onLanguageClick).toHaveBeenCalledWith("Rust");
  });

  test("more than five languages show five, and the toggle shows all of them and five again", async () => {
    h.report = {
      ...prefix,
      by_language: Array.from({ length: 7 }, (_, i) => ({ ...prefix.by_language[0]!, name: `Lang${i + 1}` })),
    };
    const target = await render();
    const rows = (): number => target.querySelectorAll("button.lang-name").length;
    const toggle = (): HTMLButtonElement => target.querySelector<HTMLButtonElement>("button.see-more")!;
    expect(rows()).toBe(5);
    expect(toggle().textContent).toBe("+2 more");

    toggle().click();
    flushSync();
    expect(rows(), "the more button shows every language").toBe(7);
    expect(toggle().textContent).toBe("show fewer");

    toggle().click();
    flushSync();
    expect(rows()).toBe(5);
    expect(toggle().textContent).toBe("+2 more");
  });
});

describe("the contacts", () => {
  function contactsView(): GraphView {
    const view: GraphView = {
      nodes: [
        { kind: "file", id: "Contacts/zed.md", label: "Zed", path: "Contacts/zed.md", node_kind: "contact" },
        { kind: "mention", id: "@@amy", label: "@@amy" },
        { kind: "file", id: "notes/a.md", label: "a.md", path: "notes/a.md" },
      ],
      edges: [],
    };
    return view;
  }

  test("list contact files and mentions, by name", async () => {
    graphData.view = contactsView();
    const target = await render();
    const pills = [...target.querySelectorAll<HTMLButtonElement>("button.ref.contact")];
    expect(pills.map((b) => b.textContent?.trim())).toEqual(["amy", "Zed"]);
  });

  test("a contact file opens its lens, or goes to the host; a mention opens its node", async () => {
    graphData.view = contactsView();
    const first = await render();
    const [amy, zed] = [...first.querySelectorAll<HTMLButtonElement>("button.ref.contact")];
    zed!.click();
    expect(openGraphForContact).toHaveBeenCalledWith("Contacts/zed.md");
    amy!.click();
    expect(openGraphAtNode).toHaveBeenCalledWith("@@amy");

    const onContactNavigate = vi.fn();
    const second = await render({ onContactNavigate });
    [...second.querySelectorAll<HTMLButtonElement>("button.ref.contact")][1]!.click();
    expect(onContactNavigate).toHaveBeenCalledWith("Contacts/zed.md");
  });
});

describe("without a workspace behind the window", () => {
  test("makes no inspector or report request and shows no report state", async () => {
    h.caps.workspace = false;
    const target = await render();

    expect(api.inspector).not.toHaveBeenCalled();
    expect(api.reportDir).not.toHaveBeenCalled();
    expect(api.reportPrefix).not.toHaveBeenCalled();
    expect(target.textContent).not.toContain("loading report");
    expect(target.querySelector(".refs-error")).toBeNull();
  });
});

describe("the shared graph load", () => {
  // Unmount first: a body still mounted would answer the invalidation with a
  // load of its own, which the next test would then share.
  afterEach(() => {
    for (const app of mounted.splice(0)) unmount(app);
    invalidateGraph();
  });

  test("a graph stream that keeps failing is started once", async () => {
    graphData.view = null;
    vi.mocked(api.graphStream).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("stream down")), 0)),
    );
    await render();
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
  });

  test("an invalidated graph loads again while the body is shown", async () => {
    vi.mocked(api.graphStream).mockResolvedValue({ nodes: [], edges: [] });
    await render();
    expect(api.graphStream).not.toHaveBeenCalled();
    invalidateGraph();
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
  });
});
