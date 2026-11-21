// @vitest-environment jsdom
//
// The keyboard's owners paint in the order they hold it, so what shows on
// top is what takes the keys: the covers over the window over the
// window-wide survey and the dialogs, the close prompt over the two covers
// it holds the keyboard over; the survey over the dialogs and over the
// command deck; the dialogs over the overlays' stack; an overlay over the
// one under it in the stack; the overlays over a survey over one terminal.

import { afterEach, describe, expect, test } from "vitest";
import { commandDeckLayer, overlayLayer, overlayStack, promptState } from "./store.svelte";
import { VIEWER_LAYER } from "./viewerLayer.svelte";

// The layers the stylesheets set, read from the sources: jsdom applies no
// stylesheet, so no mounted surface paints at its layer.
const sources = import.meta.glob(
  [
    "../components/BubbleOverlay.svelte",
    "../components/CloseConfirmOverlay.svelte",
    "../components/DisconnectOverlay.svelte",
    "../components/SessionEndedOverlay.svelte",
    "../components/ScreensaverOverlay.svelte",
    "../components/MissingTokenOverlay.svelte",
    "../components/PreflightOverlay.svelte",
    "../components/ModalShell.svelte",
    "../components/TeamDialog.svelte",
    "../components/AppStatusBar.svelte",
    "../components/PaneTreeOverlay.svelte",
    "../components/HamburgerMenu.svelte",
    "../../../web-shared/src/components/CommandDeck.svelte",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function rule(path: string, selector: string): string {
  const source = sources[path];
  if (source === undefined) throw new Error(`no source read for ${path}`);
  const at = source.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no ${selector} rule in ${path}`);
  return source.slice(at, source.indexOf("}", at));
}

function layer(file: string, selector: string): number {
  const z = /z-index:\s*(\d+)/.exec(rule(`../components/${file}`, selector))?.[1];
  if (z === undefined) throw new Error(`${selector} in ${file} names no z-index`);
  return Number(z);
}

const covers = {
  "the reconnect cover": layer("DisconnectOverlay.svelte", ".overlay"),
  "the session-ended cover": layer("SessionEndedOverlay.svelte", ".overlay"),
  "the screen lock": layer("ScreensaverOverlay.svelte", ".screensaver-backdrop"),
  "the missing-token cover": layer("MissingTokenOverlay.svelte", ".page"),
  "the preflight cover": layer("PreflightOverlay.svelte", ".preflight"),
};
const closePrompt = layer("CloseConfirmOverlay.svelte", ".overlay");
const survey = layer("BubbleOverlay.svelte", ".survey-overlay");
const terminalSurvey = layer("BubbleOverlay.svelte", ".survey-overlay.per-terminal");
const dialogs = {
  "an app-root dialog": layer("ModalShell.svelte", ".overlay"),
  "the Team dialog": layer("TeamDialog.svelte", ".team-dialog-backdrop"),
};
const chrome = {
  "the status bar": layer("AppStatusBar.svelte", ".app-statusbar"),
  "the pane tree": layer("PaneTreeOverlay.svelte", ".pane-tree-layer"),
  "the menus": layer("HamburgerMenu.svelte", ".hamburger-menu"),
};

afterEach(() => {
  overlayStack.ids = [];
  promptState.open = false;
});

describe("the keyboard's owners paint in the order they hold it", () => {
  test("every cover over the window paints over the window-wide survey and the dialogs", () => {
    for (const [cover, level] of Object.entries(covers)) {
      expect(level, `${cover} over the survey`).toBeGreaterThan(survey);
      for (const [dialog, under] of Object.entries(dialogs)) {
        expect(level, `${cover} over ${dialog}`).toBeGreaterThan(under);
      }
    }
  });

  test("the close prompt paints over the reconnect and session-ended covers and under the rest", () => {
    expect(closePrompt, "over the reconnect cover").toBeGreaterThan(covers["the reconnect cover"]);
    expect(closePrompt, "over the session-ended cover").toBeGreaterThan(covers["the session-ended cover"]);
    expect(closePrompt, "under the screen lock").toBeLessThan(covers["the screen lock"]);
    expect(closePrompt, "under the missing-token cover").toBeLessThan(covers["the missing-token cover"]);
    expect(closePrompt, "under the preflight cover").toBeLessThan(covers["the preflight cover"]);
    expect(closePrompt, "over the window-wide survey").toBeGreaterThan(survey);
  });

  test("the full-window viewers paint over the close prompt and under the lock and the auth and preflight pages", () => {
    expect(VIEWER_LAYER, "over the close prompt").toBeGreaterThan(closePrompt);
    expect(VIEWER_LAYER, "under the screen lock").toBeLessThan(covers["the screen lock"]);
    expect(VIEWER_LAYER, "under the missing-token cover").toBeLessThan(covers["the missing-token cover"]);
    expect(VIEWER_LAYER, "under the preflight cover").toBeLessThan(covers["the preflight cover"]);
  });

  test("the window-wide survey paints over the dialogs and over the command deck that holds the keyboard", () => {
    for (const [dialog, under] of Object.entries(dialogs)) {
      expect(survey, `over ${dialog}`).toBeGreaterThan(under);
    }
    overlayStack.ids = ["search", "launcher"];
    expect(survey, "over the command deck").toBeGreaterThan(commandDeckLayer());
    expect(survey, "over the menus").toBeGreaterThan(chrome["the menus"]);
  });

  test("the command deck that holds the keyboard paints over the status bar, the pane tree and the menus", () => {
    overlayStack.ids = ["launcher"];
    for (const [surface, under] of Object.entries(chrome)) {
      expect(commandDeckLayer(), `over ${surface}`).toBeGreaterThan(under);
    }
  });

  test("the dialogs paint over every overlay, the command deck under them included", () => {
    overlayStack.ids = ["search", "settings", "launcher"];
    promptState.open = true;
    for (const [dialog, level] of Object.entries(dialogs)) {
      for (const id of overlayStack.ids) {
        // An overlay's sub-layers reach up to the step under the next one.
        expect(level, `${dialog} over ${id}`).toBeGreaterThan(overlayLayer(id) + 9);
      }
      expect(level, `${dialog} over the command deck`).toBeGreaterThan(commandDeckLayer());
    }
  });

  test("an overlay opened over the command deck paints over it", () => {
    overlayStack.ids = ["launcher", "settings"];
    expect(overlayLayer("settings")).toBeGreaterThan(commandDeckLayer());
  });

  test("the overlays paint over a survey over one terminal", () => {
    overlayStack.ids = ["search", "launcher"];
    expect(overlayLayer("search"), "Search").toBeGreaterThan(terminalSurvey);
    promptState.open = true;
    expect(commandDeckLayer(), "the command deck under a dialog").toBeGreaterThan(terminalSurvey);
  });

  test("the command deck paints at the layer its host names, and over the whole page with none", () => {
    // The launcher's deck names no layer and keeps this one, over the
    // launcher's own layers (1000 at most).
    const deck = rule("../../../web-shared/src/components/CommandDeck.svelte", ".deck-overlay");
    expect(deck).toMatch(/z-index:\s*var\(--deck-layer,\s*32000\)/);
  });
});
