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

import { TerminalLinkMenu, type LinkMenuHost, type LinkRange } from "./linkMenu.svelte";

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
