import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import overlay from "./CloseConfirmOverlay.svelte?raw";
import globalCommands from "../state/commands/global.ts?raw";
import shortcuts from "../state/shortcuts.ts?raw";

// The "Hide window" command (app.window.hide): the close-confirm overlay's
// Hide answer without the prompt. Every surface -- the Mod+Shift+H chord, the
// launcher row, and the chan:command bridge -- must funnel through the SAME
// `hideWindowFromCloseConfirm()` bury IPC the overlay's Hide button uses, so
// the command can never grow a parallel hide path. Desktop-only: the IPC is an
// explicit no-op in a plain browser, so no web chord is minted and the
// launcher entry is not offered there.

describe("hide-window chord registry entry", () => {
  test("app.window.hide is a native-only Mod+Shift+H App-group descriptor", () => {
    expect(shortcuts).toMatch(
      /id: "app\.window\.hide",\s*label: "Hide window",\s*native: "Mod\+Shift\+H",\s*group: "App",/,
    );
  });

  test("the chord escapes a focused terminal", () => {
    expect(shortcuts).toMatch(
      /id: "app\.window\.hide",[\s\S]*?escapeTerminal: true,/,
    );
  });
});

describe("App.svelte keymap binding", () => {
  test("hideWindowFromCloseConfirm imported from api/desktop", () => {
    expect(app).toMatch(
      /import \{[^}]*\bhideWindowFromCloseConfirm\b[^}]*\} from "\.\/api\/desktop";/,
    );
  });

  test("hide chord is desktop-gated, branches per-OS, honors overrides", () => {
    // Gate: KeyH + isTauriDesktop. macOS: Cmd+Shift+H. Non-macOS:
    // Ctrl+Shift+H. A user override supersedes the built-in chord.
    expect(app).toMatch(
      /shortcutLetter\(e\) === "H" && isTauriDesktop\(\)[\s\S]*?e\.metaKey && !e\.ctrlKey && !e\.altKey && e\.shiftKey[\s\S]*?e\.ctrlKey && !e\.metaKey && !e\.altKey && e\.shiftKey[\s\S]*?!builtInChordSuperseded\("app\.window\.hide"\)/,
    );
    expect(app).toMatch(
      /if \(hideChord\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?void hideWindowFromCloseConfirm\(\);/,
    );
  });

  test("chan:command bridge routes app.window.hide through the same IPC", () => {
    expect(app).toMatch(
      /case "app\.window\.hide":[\s\S]{1,300}void hideWindowFromCloseConfirm\(\);[\s\S]{1,40}return;/,
    );
  });
});

describe("launcher catalog entry reuses the overlay's Hide action", () => {
  test("the catalog run() dispatches hideWindowFromCloseConfirm()", () => {
    expect(globalCommands).toMatch(
      /id: "app\.window\.hide",[\s\S]*?available: \(\) => isTauriDesktop\(\),[\s\S]*?run: \(\) => void hideWindowFromCloseConfirm\(\),/,
    );
  });

  test("the overlay's Hide button calls the identical function", () => {
    // The parity pin: if the overlay's Hide handler is ever renamed or
    // rerouted, the command must move with it (host ruling: one hide path).
    expect(overlay).toMatch(
      /function hide\(\): void \{\s*void hideWindowFromCloseConfirm\(\);/,
    );
  });
});
