// @vitest-environment jsdom
//
// A render throw in one tab body is contained by that tab: its siblings in
// the pane, the other pane and the tab strip keep working, the failed tab
// says what failed, and the card names and closes the tab that raised it.
//
// The app is mounted for real, because the claim is about what survives
// AROUND the failure: a smaller harness could show the failed body but not
// that the rest of the window is still there.
//
// One tab component is replaced by one that throws while rendering, which is
// the item's acceptance stated directly, and is what a duplicate key looks
// like from a pane's side: `each_key_duplicate` is thrown while a keyed list
// renders.
//
// Where the two boundaries divide, stated because it decides where the next
// one goes. The per-tab boundary takes a throw from that tab's own render;
// the pane boundary around the whole body takes everything else the body
// draws, including the keying of the lists themselves, which is where
// `each_key_duplicate` is raised. Pane's `visibleTabs` and its tab labels
// feed the strip, which renders outside both, so a throw there still reaches
// the window. `everyTab` is read only inside the pane boundary, so a throw
// from `allPaneTabs` is contained: it concatenates both Hybrid sides and is
// the one list here that can carry a duplicate id.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

/// The tab body that throws. Dashboard is the cheapest kind to stand in for
/// any of them: it renders whenever the pane holds one, so the throw lands on
/// mount rather than waiting for an activation.
vi.mock("./DashboardTab.svelte", () => ({
  default: function ThrowingDashboardTab() {
    throw new Error("dashboard render blew up");
  },
}));

import App from "../App.svelte";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import "../state/commands/install";
import { layout, type FileTab, type LeafNode, type Tab } from "../state/tabs.svelte";
import { ui } from "../state/store.svelte";

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});
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

const PANE_A = "boundary-pane-a";
const PANE_B = "boundary-pane-b";
const mounted: Array<Record<string, unknown>> = [];

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ],
  };
}

function fileTab(id: string): FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id,
    path: "README.md",
    content: "hello",
    saved: "hello",
    savedMtime: 1,
    mode: "source",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
}

/// Two panes side by side. The left holds the tab that throws plus a healthy
/// sibling; the right holds a healthy tab of its own, so "the rest of the
/// window" is something the assertions can see.
function seedLayout(activeTabId = "boundary-dashboard"): void {
  const dashboard: Tab = { kind: "dashboard", id: "boundary-dashboard", title: "Dashboard" };
  const left: LeafNode = {
    kind: "leaf",
    id: PANE_A,
    tabs: [dashboard, fileTab("boundary-file-a")],
    activeTabId,
  };
  const right: LeafNode = {
    kind: "leaf",
    id: PANE_B,
    tabs: [fileTab("boundary-file-b")],
    activeTabId: "boundary-file-b",
  };
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", a: PANE_A, b: PANE_B, ratio: 0.5 },
    [PANE_A]: left,
    [PANE_B]: right,
  };
  layout.rootId = "root";
  layout.activePaneId = PANE_A;
}

async function mountApp(activeTabId?: string): Promise<HTMLElement> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }) as Record<string, unknown>);
  await tick();
  await tick();
  seedLayout(activeTabId);
  await tick();
  await tick();
  return target;
}

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
  ui.authMissing = false;
  ui.disconnectBlocking = false;
  vi.restoreAllMocks();
});

function paneEl(target: HTMLElement, id: string): HTMLElement {
  const el = target.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  expect(el, `pane ${id} is rendered`).not.toBeNull();
  return el!;
}

describe("a tab whose render throws", () => {
  test("is contained in its own tab, which says what failed and names its way out", async () => {
    const target = await mountApp();
    const left = paneEl(target, PANE_A);

    const failed = left.querySelector(".pane-failed");
    expect(failed, "the failure is shown where the tab body was").not.toBeNull();
    expect(failed?.textContent, "it names what failed").toContain(
      "dashboard render blew up",
    );
    expect(failed?.textContent, "and says the unit that failed").toContain(
      "This tab could not be drawn",
    );

    const buttons = [
      ...left.querySelectorAll<HTMLButtonElement>(".pane-failed-actions button"),
    ];
    // The close names the tab that threw rather than saying "tab", because
    // the pane mounts every tab body and the one that failed is not
    // necessarily the active one.
    expect(
      buttons.map((b) => b.textContent?.trim()),
      "a retry and a named way out are offered",
    ).toEqual(["Try again", "Close Dashboard"]);
  });

  test("does not fail the pane when the tab that throws is in the background", async () => {
    // The keep-alive eaches mount every tab body, so a background tab renders
    // and can throw while the user is working in a different tab of the same
    // pane. Its card waits behind the strip the way its body would.
    const target = await mountApp("boundary-file-a");
    const left = paneEl(target, PANE_A);

    expect(left.querySelector(".editor-tab"), "the active tab draws").not.toBeNull();
    const host = left.querySelector(".tab-failed");
    expect(host, "the failure is held by the tab that raised it").not.toBeNull();
    expect(host?.classList.contains("offscreen"), "and is hidden with it").toBe(true);
  });

  test("leaves a healthy sibling drawable, and the strip switches to it", async () => {
    const target = await mountApp();
    const left = paneEl(target, PANE_A);
    expect(left.querySelector(".pane-failed"), "the throw is shown").not.toBeNull();

    // The keep-alive eaches mount every tab body in the pane, so a failure
    // that takes the pane's whole body takes the healthy sibling with it and
    // clicking that sibling in the strip has nothing to draw.
    const strip = [...left.querySelectorAll<HTMLElement>(".tabs .tab")];
    expect(strip, "both tabs are in the strip").toHaveLength(2);
    const healthy = strip.find((el) => !el.textContent?.includes("Dashboard"));
    expect(healthy, "the sibling is in the strip").toBeDefined();
    healthy!.click();
    await tick();
    await tick();

    expect(
      left.querySelector(".editor-tab"),
      "the sibling's own body is drawn",
    ).not.toBeNull();
  });

  test("leaves its own tab strip, its sibling tabs and the other pane working", async () => {
    const target = await mountApp();
    const left = paneEl(target, PANE_A);
    const right = paneEl(target, PANE_B);

    expect(left.querySelector(".pane-failed"), "the left pane failed").not.toBeNull();

    // The strip renders outside the boundary, so both tabs are still there
    // and still clickable: that is the way back to a tab that draws.
    const tabs = [...left.querySelectorAll(".tabs .tab")];
    expect(tabs, "the failed pane keeps its tab strip").toHaveLength(2);

    // The other pane never saw the throw. `.editor-tab` is the file tab
    // component's own root: `.editor-wrap` is the pane's body container and
    // renders whether the body drew or not, so it cannot fail for this.
    expect(right.querySelector(".pane-failed"), "the right pane is unaffected").toBeNull();
    expect(right.querySelector(".editor-tab"), "and still renders its body").not.toBeNull();
  });
});
