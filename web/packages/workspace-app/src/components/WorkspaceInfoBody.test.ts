// @vitest-environment jsdom
//
// WorkspaceInfoBody, mounted. The workspace inspector reads the tree store,
// the report api and the shared graph snapshot; the store and the api are
// stubbed so each test sets what the body sees and reads what it renders and
// calls.

import { flushSync, mount, tick, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { setPrivacy } from "@chan/web-shared/privacy";
import WorkspaceInfoBody from "./WorkspaceInfoBody.svelte";
import appSource from "../App.svelte?raw";
import bodySource from "./WorkspaceInfoBody.svelte?raw";
import codeReportSource from "./CodeReportSection.svelte?raw";
import fileInfoSource from "./FileInfoBody.svelte?raw";
import languageInfoSource from "./LanguageInfoBody.svelte?raw";
import tagInfoSource from "./TagInfoBody.svelte?raw";
import type { GraphView, ReportPrefix } from "../api/types";
import { graphData, invalidateGraph } from "../state/graphData.svelte";
import { ApiError } from "../api/errors";
import { terminalFromHereTarget } from "../terminal/fromHere";
import {
  allCommands,
  commandById,
  registerCommands,
  unregisterCommands,
  type Command,
} from "../state/commands";

const h = vi.hoisted(() => ({
  caps: { workspace: true, files: true, drafts: true, terminal: true },
  report: null as unknown,
  reportFails404: false,
}));

vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: h.caps,
}));

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

// The store and the tab state are the real modules with the members this
// body reads replaced: the action pill loads the command catalog, whose
// modules import the rest of both.
vi.mock("../state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/store.svelte")>()),
  fileOps: {
    downloadPathWithProgress: vi.fn(),
  },
  raiseUploadPicker: vi.fn(),
  openGraphAtNode: vi.fn(),
  openGraphForContact: vi.fn(),
  openGraphForLanguage: vi.fn(),
  revealPathInBrowser: vi.fn(),
  tree: { entries: [], loadingDirs: {}, loadedDirs: {}, dirErrors: {} },
  workspace: { info: { root: "/home/me/ws", label: "ws" } },
}));

vi.mock("../state/tabs.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/tabs.svelte")>()),
  openTerminalInActivePane: vi.fn(),
}));

import { api } from "../api/client";
import {
  fileOps,
  openGraphAtNode,
  openGraphForContact,
  openGraphForLanguage,
  raiseUploadPicker,
  revealPathInBrowser,
  workspace,
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

/// The root's actions in the order the pill shows them, each the file
/// browser's command: the root is a directory like any other.
const ROOT_ACTIONS = [
  "app.browser.open",
  "app.browser.uploadSelection",
  "app.browser.downloadSelection",
  "app.browser.newTerminal",
  "app.browser.newGraph",
];

let catalog: Command[] | null = null;

/// Registers every command again under a title that spells its id, so a row
/// shows which command it was given.
function retitleCatalog(): void {
  catalog = allCommands();
  unregisterCommands(() => true);
  registerCommands(catalog.map((command) => ({ ...command, title: `<${command.id}>` })));
}

function title(id: string): string {
  const command = commandById(id);
  if (!command) throw new Error(`no command ${id}`);
  return command.title;
}

/// The pill's words, the primary action first.
function actions(target: HTMLElement): string[] {
  return [target.querySelector(".pill-main")?.textContent?.trim() ?? "", ...menu(target)];
}

beforeEach(() => {
  // A loaded graph, so the body's ensureGraphLoaded has nothing to fetch.
  graphData.view = { nodes: [], edges: [] };
  graphData.partial = false;
  h.caps.workspace = true;
  h.report = null;
  h.reportFails404 = false;
  // The file browser's Open may not be registered in the catalog this test
  // loads. A missing one is registered here under its catalog title, so the
  // pill's words resolve.
  if (!commandById("app.browser.open")) {
    registerCommands([
      {
        id: "app.browser.open",
        title: "Open",
        category: "File Browser",
        scope: "app",
        surface: "browser",
        requirement: "files",
        available: () => true,
        run: () => {},
      },
    ]);
  }
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  graphData.view = null;
  graphData.partial = false;
  if (catalog) {
    unregisterCommands(() => true);
    registerCommands(catalog);
    catalog = null;
  }
  vi.clearAllMocks();
});

describe("the workspace root's actions", () => {
  test("lead with Open, and offer upload, download and a terminal behind the caret", async () => {
    const target = await render();
    expect(target.querySelector(".pill-main")?.textContent?.trim()).toBe("Open");
    expect(menu(target)).toEqual(["Upload", "Download", "New terminal here"]);
  });

  test("add New graph here only when the host can scope a graph", async () => {
    const onSetAsScope = vi.fn();
    const target = await render({ onSetAsScope });
    expect(menu(target)).toContain("New graph here");
    menuItem(target, "New graph here").click();
    expect(onSetAsScope).toHaveBeenCalledTimes(1);
  });

  test("every action is worded by the title of a registered file browser command", async () => {
    const target = await render({ onSetAsScope() {} });
    expect(actions(target)).toEqual(ROOT_ACTIONS.map(title));
  });

  test("each action is the file browser's command for it", async () => {
    retitleCatalog();
    const target = await render({ onSetAsScope() {} });
    expect(actions(target)).toEqual(ROOT_ACTIONS.map((id) => `<${id}>`));
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

    // Upload raises the picker the file browser's Upload raises for a
    // directory, the desktop's own where there is one, and the body keeps no
    // file input of its own.
    menu(target);
    menuItem(target, "Upload").click();
    expect(raiseUploadPicker).toHaveBeenCalledExactlyOnceWith("");
    expect(target.querySelector("input[type='file']")).toBeNull();

    menu(target);
    menuItem(target, "Download").click();
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

  test("each language opens the graph on it, through the host when it asks", async () => {
    h.report = prefix;
    const first = await render();
    const rows = [...first.querySelectorAll<HTMLButtonElement>("button.lang-name")];
    expect(rows.map((b) => b.textContent?.trim())).toEqual(["Rust", "TOML"]);
    expect(rows[0]!.title).toBe("open in graph");
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

describe("privacy mode", () => {
  afterEach(async () => { await setPrivacy({ enabled: false }); });

  // The Workspace slide and the root's inspector show this one body, so both
  // variants conceal the root path, which names the user's home.
  test.each(["dashboard", "inspector"] as const)("the %s variant conceals the root path, reveals it on request and follows a toggle", async (variant) => {
    const target = await render({ variant });
    const shown = () => {
      expect(target.querySelector(".v.path")?.textContent).toBe("/home/me/ws");
      expect(target.querySelector("h3.title")?.getAttribute("title")).toBe("/home/me/ws");
      expect(target.querySelector(".redacted")).toBeNull();
    };
    shown();
    await setPrivacy({ enabled: true });
    await tick();
    // Nowhere in the body, the heading's hover title included; the
    // workspace's name stays.
    expect.soft(target.innerHTML).not.toContain("/home/me");
    expect.soft(target.querySelector('[aria-label="workspace root path hidden"]')?.textContent).toBe("Hidden");
    expect(target.querySelector("h3.title")?.textContent?.trim()).toBe("ws");
    (target.querySelector('[aria-label="Reveal workspace root path"]') as HTMLButtonElement).click();
    await tick();
    expect(target.querySelector(".v.path")?.textContent).toBe("/home/me/ws");
    // The reveal is the field's own: a tooltip never reveals it implicitly.
    expect(target.querySelector("h3.title")?.hasAttribute("title")).toBe(false);
    await setPrivacy({ enabled: false });
    await tick();
    shown();
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

  /// A contact file and a mention, the two kinds the contacts list.
  const people = (): GraphView => ({
    nodes: [
      { kind: "file", id: "Contacts/zed.md", label: "Zed", path: "Contacts/zed.md", node_kind: "contact" },
      { kind: "mention", id: "@@amy", label: "@@amy" },
    ],
    edges: [],
  });
  const pills = (target: HTMLElement) =>
    [...target.querySelectorAll<HTMLButtonElement>("button.ref.contact")].map((b) => b.textContent?.trim());

  test("the contacts say they are loading while a first load streams", async () => {
    graphData.view = null;
    let finish!: (view: GraphView) => void;
    vi.mocked(api.graphStream).mockImplementation(async (_scope, opts) => {
      opts?.onNodes?.(people().nodes, people());
      return new Promise<GraphView>((resolve) => {
        finish = resolve;
      });
    });
    const target = await render();
    await settle();

    expect(target.textContent).toContain("loading contacts...");
    expect(pills(target)).toEqual([]);

    finish(people());
    await settle();
    expect(target.textContent).not.toContain("loading contacts...");
    expect(pills(target)).toEqual(["amy", "Zed"]);
  });

  test("the contacts name a failed first load's error, not its partial view", async () => {
    graphData.view = null;
    vi.mocked(api.graphStream).mockImplementation(async (_scope, opts) => {
      opts?.onNodes?.(people().nodes, people());
      throw new Error("stream down");
    });
    const target = await render();
    await settle();

    expect(target.textContent).toContain("contacts unavailable: stream down");
    expect(pills(target)).toEqual([]);
  });

  test("the contacts say they are rebuilding over a gated answer", async () => {
    graphData.view = people();
    graphData.gated = true;
    const target = await render();

    expect(target.textContent).toContain("rebuilding contacts...");
    expect(pills(target)).toEqual([]);
  });

  test("a refresh in flight keeps the complete contacts", async () => {
    graphData.view = people();
    graphData.loading = true;
    const target = await render();

    expect(target.textContent).not.toContain("loading contacts...");
    expect(pills(target)).toEqual(["amy", "Zed"]);
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

describe("the laid-out body", () => {
  // Vitest loads no component CSS, so these compile the body's and the code
  // report's stylesheets with the scope hashes their mounted elements carry,
  // and App's theme token blocks, and inject them; jsdom then cascades the
  // real rules. jsdom lays nothing out: each test reads the rule that decides
  // the layout, and the browser reads the layout itself.
  const info = workspace.info;

  afterEach(() => {
    (workspace as { info: unknown }).info = info;
    for (const el of document.head.querySelectorAll("style[data-body-css]")) el.remove();
    delete document.documentElement.dataset.theme;
  });

  function componentCss(source: string, hash: string): string {
    const css = compile(source, { filename: "Body.svelte", css: "external", cssHash: () => hash }).css?.code;
    if (!css) throw new Error("no stylesheet compiled");
    return css;
  }

  function scopeHash(el: Element | null): string {
    const hash = [...(el?.classList ?? [])].find((c) => /^svelte-[a-z0-9]+$/.test(c));
    if (!hash) throw new Error("no scope hash on the element");
    return hash;
  }

  function injectCss(target: HTMLElement): void {
    const sheets = [
      componentCss(appSource, "svelte-app-unused"),
      componentCss(bodySource, scopeHash(target.querySelector(".info"))),
    ];
    const report = target.querySelector(".code-report");
    if (report) sheets.push(componentCss(codeReportSource, scopeHash(report)));
    for (const css of sheets) {
      const style = document.createElement("style");
      style.dataset.bodyCss = "";
      style.textContent = css;
      document.head.append(style);
    }
  }

  /// A computed value with each var() replaced by the custom property's
  /// value on that element (or the fallback), recursively.
  function resolved(el: Element, value: string, depth = 0): string {
    if (depth > 10 || !value.includes("var(")) return value.trim();
    const styles = getComputedStyle(el);
    const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name: string, fallback?: string) => {
      return styles.getPropertyValue(name).trim() || (fallback ?? "").trim();
    });
    return resolved(el, out, depth + 1);
  }

  /// WCAG contrast ratio of two #rrggbb colours.
  function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
      const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!);
    };
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  test("the root path is one left-to-right run inside a cell that clips its start", async () => {
    (workspace as { info: unknown }).info = { root: "/work/tmp/chan-smoke-X", label: "chan-smoke-X" };
    const target = await render({ variant: "dashboard" });
    injectCss(target);
    const cell = target.querySelector<HTMLElement>(".v.path")!;

    // The cell runs right to left, so a path wider than it loses its start
    // and keeps its tail, the workspace's own name, behind a leading ellipsis.
    expect(getComputedStyle(cell).direction).toBe("rtl");
    expect(getComputedStyle(cell).textOverflow).toBe("ellipsis");
    // The path inside is a left-to-right isolate, so the cell's direction
    // does not reorder it: the leading slash stays first, not moved to the
    // end. The whole text is in it, in the source's order.
    const isolate = cell.querySelector("bdi");
    expect(isolate?.getAttribute("dir")).toBe("ltr");
    expect(isolate?.textContent).toBe("/work/tmp/chan-smoke-X");
    expect(cell.textContent).toBe(isolate?.textContent);
  });

  test("every key column on the slide fits its longest key, and all of them line up", async () => {
    h.report = prefix;
    const target = await render({ variant: "dashboard" });
    await vi.waitFor(() => expect(target.querySelector(".code-report")).not.toBeNull());
    injectCss(target);
    const grids = [...target.querySelectorAll<HTMLElement>(".meta-grid")];
    // The root's directory, the counts, the code report's totals and its
    // COCOMO estimate.
    expect(grids.map((g) => g.querySelector(".k")?.textContent)).toEqual(["directory", "files", "indexed", "effort"]);
    expect(target.textContent).toContain("subdirectories");

    const columns = grids.map((g) => getComputedStyle(g).gridTemplateColumns);
    // The key column grows to its widest key, so "subdirectories" never
    // runs into its value, from a floor every grid shares so their value
    // columns start at one edge.
    for (const c of columns) expect(c).toMatch(/^minmax\(\d+(\.\d+)?em, max-content\) 1fr$/);
    expect(new Set(columns).size).toBe(1);
  });

  test("every inspector body's key grid takes the code report's rule", () => {
    // The file, language and tag inspectors show the same code report under
    // their own grids, so their key columns line up only on one rule.
    const rule = (source: string) =>
      componentCss(source, "svelte-body").match(/\.meta-grid\.svelte-body\s*\{[^}]*grid-template-columns:\s*([^;]+);/)?.[1];
    const report = rule(codeReportSource);
    expect(report).toMatch(/max-content/);
    expect({
      workspace: rule(bodySource),
      file: rule(fileInfoSource),
      language: rule(languageInfoSource),
      tag: rule(tagInfoSource),
    }).toEqual({ workspace: report, file: report, language: report, tag: report });
  });

  test.each(["light", "dark"] as const)("the workspace chip's label takes the theme's text colour on its card fill in the %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;
    const target = await render({ variant: "dashboard" });
    injectCss(target);
    const chip = target.querySelector<HTMLElement>(".kind-chip.workspace")!;
    expect(chip.textContent).toBe("workspace");
    const style = getComputedStyle(chip);

    // Tokens, not literals, so the label follows the theme the way the
    // fill already does.
    expect(style.color).toBe("var(--text)");
    // jsdom does not expand a shorthand that holds a var(): the fill is
    // read from the shorthand itself.
    expect(style.background).toBe("var(--bg-card)");
    const color = resolved(chip, style.color);
    const fill = resolved(chip, style.background);
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(fill).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(color, fill)).toBeGreaterThanOrEqual(4.5);
  });
});
