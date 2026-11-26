// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) => {
  const fixture = await (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal);
  return { ...fixture, loadGhosttyKit: vi.fn(fixture.loadGhosttyKit) };
});

import TerminalTab from "./TerminalTab.svelte";
import { loadGhosttyKit } from "../terminal/backend";
// Build-time contract: the app entry imports fonts.css, so the bundled face starts loading at boot.
import main from "../main.ts?raw";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import {
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
} from "../__tests__/terminalTab";

import { ghosttyFixture, ghosttyFontFamily, mountGhosttyTerminal, openedGhostty } from "../__tests__/ghosttyTab";

installTerminalDom();

// Build-time contract: fonts.css declares the face under the family the terminal requests, and loads it from a relative url since the app is served under a tenant prefix; vitest empties CSS imports, so the file is read from disk.
const fonts = readFileSync("src/fonts.css", "utf8");

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.mocked(loadGhosttyKit).mockClear();
});

// TerminalTab ships Source Code Pro Regular and defaults renderers to a
// non-blinking block cursor at 14 px. terminal/font.test.ts owns the complete
// OS/preference chain matrix; this file covers the component integration.

describe("the mounted terminal", () => {
  test("waits for the bundled face before it constructs or opens the widget", async () => {
    let loaded!: (faces: FontFace[]) => void;
    vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise<FontFace[]>((r) => (loaded = r)));
    const [tab] = seatTerminals([terminalTab()]);
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TerminalTab, {
      target,
      props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
    });
    // The terminal has reached the wait: it asked for the face. The widget's
    // load is the next thing it starts, so a terminal that did not wait
    // would have started it within these turns, long before a renderer
    // exists to count.
    await vi.waitFor(() => expect(loaded, "the terminal asked for the face").toBeDefined());
    for (let i = 0; i < 4; i += 1) await tick();
    expect(loadGhosttyKit, "the widget's load has not started while the face loads").not.toHaveBeenCalled();
    expect(ghosttyFixture.terminals, "nothing built while the face loads").toHaveLength(0);

    loaded([{} as FontFace]);
    const term = await openedGhostty(target);
    expect(loadGhosttyKit).toHaveBeenCalledOnce();
    expect(ghosttyFixture.terminals).toHaveLength(1);
    expect(ghosttyFontFamily(term)).toContain("Source Code Pro");
    await unmount(component);
  });

  test("takes the font size from the settings, 14px without one", async () => {
    const [first] = seatTerminals([terminalTab()]);
    const { term: plain } = await mountGhosttyTerminal(TerminalTab, first!);
    expect(plain.options.fontSize).toBe(14);
    resetTerminals();

    __testSetStandalonePreferences(terminalPreferences({ font_size: 18 }));
    const [second] = seatTerminals([terminalTab()]);
    const { term: sized } = await mountGhosttyTerminal(TerminalTab, second!);
    expect(sized.options.fontSize).toBe(18);
  });

  test("uses a non-blinking block cursor", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options).toMatchObject({ cursorBlink: false, cursorStyle: "block" });
  });
});

describe("TerminalTab font + cursor parity", () => {
  test("fonts.css declares the face under the family the terminal requests", async () => {
    // Renaming the family on either side leaves every terminal on a fallback
    // face with no error, so the declared name is read from the stylesheet
    // and the requested one from what the mounted terminal asks for.
    const declared = /@font-face\s*\{[^}]*font-family:\s*(["'])(.*?)\1/.exec(fonts)?.[2];
    expect(declared, "fonts.css declares a family").toBeTruthy();

    vi.mocked(document.fonts.load).mockClear();
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const first = String(ghosttyFontFamily(term)).split(",")[0]!.trim().replace(/^["']|["']$/g, "");
    expect(first, "the first family the widget is given").toBe(declared);
    const awaited = vi.mocked(document.fonts.load).mock.calls.map(([font]) => /"([^"]+)"/.exec(String(font))?.[1]);
    expect(awaited, "the face the terminal waits for before it builds a renderer").toContain(declared);
  });

  test("@font-face src is relative so it resolves under a tenant prefix", () => {
    // WorkspaceHost mounts each tenant under a single-segment slug, and
    // vite builds with base "./" for exactly that reason. An absolute
    // `/static/...` src resolves against the origin root instead, where
    // the launcher root fallback answers with index.html and the face
    // fails to decode with no visible error.
    expect(fonts).toMatch(
      /url\(['"]\.\/fonts\/SourceCodePro-Regular\.otf\.woff2['"]\)/,
    );
    expect(fonts).not.toMatch(/url\(['"]?\//);
  });

  test("the woff2 and its OFL notice ship in the package", () => {
    // OFL 1.1 permits bundling the face inside chan only while the
    // notice travels with it, so the copy is a licence obligation.
    // latin1 keeps one char per byte, so length is the byte count.
    const woff2 = readFileSync(
      "src/fonts/SourceCodePro-Regular.otf.woff2",
      "latin1",
    );
    expect(woff2.length).toBeGreaterThan(1024);
    // woff2 magic, so a truncated or placeholder file fails loudly here
    // rather than as an undecodable face in the browser.
    expect(woff2.slice(0, 4)).toBe("wOF2");
    const ofl = readFileSync("src/fonts/OFL.txt", "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE");
  });

  test("fonts.css is imported at app boot so the face starts loading early", () => {
    expect(main).toMatch(/import\s+"\.\/fonts\.css"/);
  });
});
