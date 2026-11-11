// @vitest-environment jsdom
//
// The file browser follows a light/dark switch through CSS alone: its rows,
// toolbar and rails take every colour from the theme tokens App.svelte
// defines under `[data-theme]`. Vitest loads no component CSS, so this test
// compiles the real stylesheets (App's token blocks, FileBrowserSurface's and
// FileTree's scoped rules, with the scope hash the mounted DOM carries) and
// injects them; jsdom then cascades the tokens, and `resolved` substitutes
// their values for the var() references jsdom leaves in a computed colour. A
// mounted browser switches twice and must end in exactly the colours a fresh
// mount in that theme has.

import { mount, tick, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ workspace: true }));
vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: {
    get workspace() {
      return caps.workspace;
    },
    files: true,
    drafts: true,
    terminal: true,
  },
}));

import FileBrowserSurface from "./FileBrowserSurface.svelte";
import appSource from "../App.svelte?raw";
import surfaceSource from "./FileBrowserSurface.svelte?raw";
import treeSource from "./FileTree.svelte?raw";
import { setBrowserVim } from "../state/browserKeys.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { browserSelection, hybridSurfaceThemes, refreshTree, refreshWorkspace, ui } from "../state/store.svelte";
import { layout, type BrowserTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

type Theme = "light" | "dark";
const PANE = "fb-theme-pane";
const startTheme = ui.theme;
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(async () => {
  timers = trackTimers();
  setBrowserVim(false);
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 3, textCount: 3 },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hi" },
      { path: "src/main.rs", kind: "text", size: 12, mtime: 100, content: "fn main() {}" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  browserSelection.path = "README.md";
  browserSelection.paths = ["README.md"];
  browserSelection.showWorkspace = false;
});

afterEach(async () => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  for (const el of document.head.querySelectorAll("style[data-theme-test]")) el.remove();
  await settle();
  uninstallDemoWorkspace();
  timers.release();
  ui.theme = startTheme;
  delete hybridSurfaceThemes.browser;
  delete document.documentElement.dataset.theme;
});

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

type Switch = "window" | "override";

/// Switch the window's theme, or the browser surface's own override over a
/// window theme left as it is.
async function switchTo(theme: Theme, by: Switch = "window"): Promise<void> {
  if (by === "override") hybridSurfaceThemes.browser = theme;
  else {
    ui.theme = theme;
    document.documentElement.dataset.theme = theme;
  }
  await settle();
}

async function mountBrowser(): Promise<HTMLElement> {
  const tab: BrowserTab = { kind: "browser", id: "fb-theme", title: "Files", inspectorOpen: false };
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  const live = (layout.nodes[PANE] as LeafNode).tabs[0] as BrowserTab;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props: { variant: "tab", tab: live } }));
  await vi.waitFor(() => expect(target.querySelectorAll(".row").length).toBeGreaterThanOrEqual(3));
  await settle();
  return target;
}

/// A component's scoped stylesheet, compiled from its source with the scope
/// hash its mounted elements carry.
function componentCss(source: string, hash: string): string {
  const css = compile(source, { filename: "Theme.svelte", css: "external", cssHash: () => hash }).css?.code;
  if (!css) throw new Error("no stylesheet compiled");
  return css;
}

function scopeHash(el: Element | null): string {
  const hash = [...(el?.classList ?? [])].find((c) => /^svelte-[a-z0-9]+$/.test(c));
  if (!hash) throw new Error("no scope hash on the element");
  return hash;
}

/// Inject the theme tokens and both components' rules, once per document.
function injectStylesheets(target: HTMLElement): void {
  if (document.head.querySelector("style[data-theme-test]")) return;
  const sheets = [
    componentCss(appSource, "svelte-app-unused"),
    componentCss(surfaceSource, scopeHash(target.querySelector(".browser"))),
    componentCss(treeSource, scopeHash(target.querySelector(".tree"))),
  ];
  for (const css of sheets) {
    const style = document.createElement("style");
    style.dataset.themeTest = "";
    style.textContent = css;
    document.head.append(style);
  }
}

/// A computed value with each var() replaced by the custom property's value
/// on that element (or the fallback), recursively.
function resolved(el: Element, value: string, depth = 0): string {
  if (depth > 10 || !value.includes("var(")) return value.trim();
  const styles = getComputedStyle(el);
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name: string, fallback?: string) => {
    const own = styles.getPropertyValue(name).trim();
    return own || (fallback ?? "").trim();
  });
  return resolved(el, out, depth + 1);
}

/// The colours of every element of the browser: text, background and
/// border, each resolved to the theme's literal value.
function paint(target: HTMLElement): string[] {
  const root = target.querySelector(".browser")!;
  return [root, ...root.querySelectorAll("*")].map((el) => {
    const s = getComputedStyle(el);
    const classes = [...el.classList].filter((c) => !c.startsWith("svelte-")).join(".");
    const colour = (prop: string) => resolved(el, s.getPropertyValue(prop));
    return `${el.tagName.toLowerCase()}.${classes} color=${colour("color")} bg=${colour("background-color") || colour("background")} border=${colour("border-bottom-color") || colour("border-bottom")}`;
  });
}

/// The resolved colours of the file rows alone, the cells a user reads.
function rows(target: HTMLElement): Array<{ name: string; color: string; bg: string }> {
  return [...target.querySelectorAll(".row")].map((row) => {
    const s = getComputedStyle(row);
    return {
      name: (row.querySelector(".name")?.textContent ?? "").trim(),
      color: resolved(row, s.color),
      bg: resolved(row, s.backgroundColor || s.background),
    };
  });
}

describe("the file browser switched twice", () => {
  test.each([
    { by: "window" as Switch, order: ["light", "dark", "light"] as Theme[] },
    { by: "window" as Switch, order: ["dark", "light", "dark"] as Theme[] },
    { by: "override" as Switch, order: ["light", "dark", "light"] as Theme[] },
    { by: "override" as Switch, order: ["dark", "light", "dark"] as Theme[] },
  ])("by the $by theme, $order ends in a fresh mount's colours at each step", async ({ by, order }) => {
    const [first, ...rest] = order as [Theme, ...Theme[]];
    // An override starts over the opposite window theme, so its first step
    // already differs from the window's.
    if (by === "override") await switchTo(first === "light" ? "dark" : "light");
    await switchTo(first, by);
    const target = await mountBrowser();
    injectStylesheets(target);
    const firstRows = rows(target);
    expect(firstRows.map((r) => r.name)).toEqual(expect.arrayContaining(["README.md", "notes", "src"]));
    for (const row of firstRows) expect(row.color, `${row.name} resolves to a literal colour`).toMatch(/^#[0-9a-f]{3,8}$/i);
    const seen = { [first]: paint(target) } as Record<Theme, string[]>;

    for (const theme of rest) {
      await switchTo(theme, by);
      const live = paint(target);
      const freshTarget = await mountBrowser();
      const fresh = paint(freshTarget);
      expect(rows(target), `rows after the switch to ${theme}`).toEqual(rows(freshTarget));
      expect(live, `every element after the switch to ${theme}`).toEqual(fresh);
      if (seen[theme]) expect(live, `back in ${theme}`).toEqual(seen[theme]);
      seen[theme] = live;
      unmount(mounted.pop()!);
      freshTarget.remove();
    }
    expect(seen.light, "light and dark paint differently").not.toEqual(seen.dark);
  });
});
