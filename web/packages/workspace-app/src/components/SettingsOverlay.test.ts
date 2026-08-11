// Clobber-safety source pins for the settings surface. Every write must derive
// a partial field patch and flow through revision conflict replay.

import { describe, expect, test } from "vitest";
import overlaySource from "./SettingsOverlay.svelte?raw";
import globalSource from "./settings/GlobalSection.svelte?raw";
import surfaceThemeFieldSource from "./settings/SurfaceThemeField.svelte?raw";
import terminalSource from "./settings/TerminalSection.svelte?raw";
import editorSource from "./settings/EditorSection.svelte?raw";
import numberFieldSource from "./settings/NumberField.svelte?raw";

describe("SettingsOverlay config writes (source pins)", () => {
  test("the default write path routes through updateGlobalConfigSerial", () => {
    expect(overlaySource).toMatch(
      /updateGlobalConfigSerial\(\(prefs\) => mutationPatch\(prefs, mutate\)\)/,
    );
  });

  test("it never bypasses the revisioned partial-write helper", () => {
    expect(overlaySource).not.toMatch(/api\.updateConfig\(/);
  });

  test("the theme control reuses the store's setThemeChoice setter", () => {
    expect(globalSource).toMatch(/setThemeChoice\(/);
  });

  test("the per-surface theme control reuses the store set + clear setters", () => {
    // Light/Dark apply live + persist via setHybridSurfaceTheme; Inherit
    // drops the key via clearHybridSurfaceTheme, mirroring how the theme
    // control reuses setThemeChoice rather than bypassing conflict replay.
    expect(surfaceThemeFieldSource).toMatch(/setHybridSurfaceTheme\(/);
    expect(surfaceThemeFieldSource).toMatch(/clearHybridSurfaceTheme\(/);
  });

  test("the terminal font control commits the choice with nothing to fetch", () => {
    // Source Code Pro ships in the SPA bundle, so the control is a plain
    // preference write with no download leg to sequence behind.
    expect(terminalSource).toMatch(/function selectFont\(/);
    expect(terminalSource).not.toMatch(/fontsSourceCodeProDownload/);
  });

  test("appearance size controls clamp and commit on blur or Enter", () => {
    // The clamp-and-commit mechanics live in the NumberField primitive;
    // the sections hand it their bounds and their commit, including the
    // editor's nullable use-the-theme path.
    expect(terminalSource).toMatch(/font_size: next/);
    expect(editorSource).toMatch(/editor_font_size: next/);
    expect(editorSource).toMatch(/commitFontSize\(null\)/);
    expect(numberFieldSource).toMatch(/onblur=\{commit\}/);
    expect(numberFieldSource).toMatch(/onkeydown=\{onKeydown\}/);
  });

  test("secret masking is editable with its xterm-only scope stated", () => {
    // Post linux-terminal-grid the control would do nothing under the
    // platform default on Linux, so it ships editable only with the
    // xterm.js scope stated in the row itself. The suffix list stays
    // read-only: normalize_terminal_secret_mask_suffixes drops, dedupes
    // and truncates, and a chip editor would have to mirror all three.
    expect(terminalSource).toMatch(/label="Secret masking"/);
    expect(terminalSource).toMatch(/xterm\.js terminals only/);
    expect(terminalSource).toMatch(/secret_masking: on/);
    expect(terminalSource).not.toMatch(/secret_mask_suffixes:\s/);
  });
});
