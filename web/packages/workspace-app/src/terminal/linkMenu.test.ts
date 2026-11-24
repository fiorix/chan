import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  opened: [] as string[],
  edited: [] as string[],
  editorAnswer: null as string | null,
  status: { status: "", statusKind: null as string | null },
}));

vi.mock("../editor/external_links", () => ({
  isOpenableExternalUrl: (url: string) => /^(https?|mailto|tel):/i.test(url),
  openExternalUrl: async (url: string) => {
    calls.opened.push(url);
    return true;
  },
}));
vi.mock("./linkActions", () => ({
  editorRefusalForWindow: () => null,
  serverHostName: async () => "build-box",
  openTerminalFileInEditor: async (path: string) => {
    calls.edited.push(path);
    return calls.editorAnswer;
  },
}));
vi.mock("../state/store.svelte", () => ({
  ui: calls.status,
  copyTextToClipboard: vi.fn(),
  setTransientStatus: vi.fn(),
}));

import { TerminalLinkMenu, xtermLinkHandlers, type LinkMenuHost, type LinkRange } from "./linkMenu.svelte";

const RANGE: LinkRange = { start: { x: 2, y: 4 }, end: { x: 20, y: 4 } };

function host(overrides: Partial<LinkMenuHost> = {}) {
  const log: string[] = [];
  const value: LinkMenuHost = {
    blocked: () => false,
    requestCwd: () => log.push("cwd?"),
    cwd: () => "/home/me/repo",
    anchorKey: () => "anchor",
    open: () => log.push("open"),
    close: () => log.push("close"),
    focusTerminal: () => log.push("focus"),
    focusTerminalAfterWait: () => log.push("focus after wait"),
    ...overrides,
  };
  return { value, log };
}

const click = (init: MouseEventInit = {}) => new MouseEvent("mouseup", { button: 0, detail: 1, ...init });

beforeEach(() => {
  calls.opened = [];
  calls.edited = [];
  calls.editorAnswer = null;
  calls.status.status = "";
});

describe("TerminalLinkMenu", () => {
  test("a click on a web link opens the menu and asks for no directory", async () => {
    const { value, log } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("https://example.com/a", RANGE, click());
    expect(log).toEqual(["open"]);
    expect(links.menu?.link).toMatchObject({ kind: "web", host: "example.com" });
    expect(calls.opened).toEqual([]);
  });

  test("Ctrl with a click opens the link with no menu", async () => {
    const { value, log } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("https://example.com/a", RANGE, click({ ctrlKey: true }));
    expect(calls.opened).toEqual(["https://example.com/a"]);
    expect(log).toEqual([]);
    expect(links.menu).toBeNull();
  });

  test("a relative file link reads the shell's directory asked for at the click", async () => {
    const { value, log } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("./notes.md", RANGE, click());
    expect(log).toEqual(["cwd?", "open"]);
    links.noteCwd();
    await links.openInEditor();
    expect(calls.edited).toEqual(["/home/me/repo/notes.md"]);
  });

  test("an open on its way closes the menu and hands the terminal the keyboard as after a wait", async () => {
    const { value, log } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("/srv/notes.md", RANGE, click());
    await links.openInEditor();
    expect(links.menu).toBeNull();
    expect(log).toEqual(["open", "close", "focus after wait"]);
  });

  test("a menu dismissed while its open waits lands the open and touches neither the bubble nor the keyboard", async () => {
    const { value, log } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("./notes.md", RANGE, click());
    const opening = links.openInEditor();
    links.dismiss();
    links.noteCwd();
    await opening;
    expect(calls.edited).toEqual(["/home/me/repo/notes.md"]);
    expect(log).toEqual(["cwd?", "open"]);
  });

  test("the menu is stale once the link's rows or their place on the screen change", async () => {
    let anchor = "row 4: https://example.com/a";
    const { value } = host({ anchorKey: () => anchor });
    const links = new TerminalLinkMenu(value);
    await links.onLink("https://example.com/a", RANGE, click());
    expect(links.stale()).toBe(false);
    anchor = "row 3: https://example.com/a";
    expect(links.stale()).toBe(true);
  });

  test("a refused open keeps the menu with the entry disabled and its reason", async () => {
    const { value } = host();
    const links = new TerminalLinkMenu(value);
    await links.onLink("/srv/gone.md", RANGE, click());
    calls.editorAnswer = "not found";
    await links.openInEditor();
    expect(links.menu?.editorRefusal).toBe("not found");
  });
});

describe("xtermLinkHandlers", () => {
  type Seen = { target: string; range: LinkRange; ctrl: boolean };

  function xterm(state: { tracking?: boolean; selection?: boolean } = {}) {
    const seen: Seen[] = [];
    const terminal = {
      hasSelection: () => state.selection ?? false,
      modes: { mouseTrackingMode: (state.tracking ? "vt200" : "none") as "vt200" | "none" },
    };
    const hooks = xtermLinkHandlers(
      () => terminal,
      (target, range, event) => seen.push({ target, range, ctrl: event.ctrlKey }),
    );
    // xterm.js's 1-based range, as both hooks receive it.
    const range = { start: { x: 3, y: 5 }, end: { x: 21, y: 5 } };
    const web = (event: MouseEvent) => {
      hooks.webLink.options.hover(event, "https://example.com/a", range);
      hooks.webLink.handler(event, "https://example.com/a");
    };
    const osc8 = (event: MouseEvent) => hooks.linkHandler.activate(event, "file:///srv/a.md", range);
    return { seen, web, osc8, hooks };
  }

  test("a click reports the link with its 0-based cells, from either hook", () => {
    const { seen, web, osc8, hooks } = xterm();
    web(click());
    osc8(click({ ctrlKey: true }));
    expect(seen).toEqual([
      { target: "https://example.com/a", range: RANGE, ctrl: false },
      { target: "file:///srv/a.md", range: RANGE, ctrl: true },
    ]);
    expect(hooks.linkHandler.allowNonHttpProtocols).toBe(true);
  });

  test("a double click's second release and the end of a drag selection are not link clicks", () => {
    const { seen, web } = xterm();
    web(click({ detail: 2 }));
    const selected = xterm({ selection: true });
    selected.web(click());
    expect([...seen, ...selected.seen]).toEqual([]);
  });

  test("under mouse tracking a click is the program's unless Shift held it", () => {
    const { seen, web } = xterm({ tracking: true });
    web(click());
    expect(seen).toEqual([]);
    web(click({ shiftKey: true }));
    expect(seen.map((s) => s.target)).toEqual(["https://example.com/a"]);
  });

  test("the addon's handler reports only the URL its last hover named, whose range it carries", () => {
    const { seen, hooks } = xterm();
    hooks.webLink.handler(click(), "https://example.com/a");
    hooks.webLink.options.hover(click(), "https://example.com/a", { start: { x: 3, y: 5 }, end: { x: 21, y: 5 } });
    hooks.webLink.handler(click(), "https://example.com/other");
    expect(seen).toEqual([]);
  });
});
