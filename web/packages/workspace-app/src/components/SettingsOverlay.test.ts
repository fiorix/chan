// Clobber-safety source pins for the settings surface. Every write must derive
// a partial field patch and flow through revision conflict replay.

import { describe, expect, test } from "vitest";
import overlaySource from "./SettingsOverlay.svelte?raw";
import appearanceSource from "./settings/AppearanceSection.svelte?raw";
import terminalSource from "./settings/TerminalSection.svelte?raw";
import editorSource from "./settings/EditorSection.svelte?raw";

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
    expect(appearanceSource).toMatch(/setThemeChoice\(/);
  });

  test("the per-surface theme control reuses the store set + clear setters", () => {
    // Light/Dark apply live + persist via setHybridSurfaceTheme; Inherit
    // drops the key via clearHybridSurfaceTheme, mirroring how the theme
    // control reuses setThemeChoice rather than bypassing conflict replay.
    expect(appearanceSource).toMatch(/setHybridSurfaceTheme\(/);
    expect(appearanceSource).toMatch(/clearHybridSurfaceTheme\(/);
  });

  test("the terminal font control downloads Source Code Pro before persist", () => {
    // The download endpoint is fired so the preference is only committed
    // after the woff2 lands (matching the terminal card invariant).
    expect(terminalSource).toMatch(/api\.fontsSourceCodeProDownload\(\)/);
  });

  test("appearance size controls clamp and commit on blur or Enter", () => {
    expect(terminalSource).toMatch(/font_size: next/);
    expect(terminalSource).toMatch(/onblur=\{commitFontSize\}/);
    expect(editorSource).toMatch(/editor_font_size: next/);
    expect(editorSource).toMatch(/editor_font_size: null/);
    expect(editorSource).toMatch(/onblur=\{commitFontSize\}/);
  });

  test("secret masking is display-only in terminal settings", () => {
    // The row renders the effective state and suffixes but owns no commit
    // path; the values persist via hand-edited TOML or PATCH only.
    expect(terminalSource).toMatch(/label="Secret masking"/);
    expect(terminalSource).not.toMatch(/secret_masking:\s/);
    expect(terminalSource).not.toMatch(/secret_mask_suffixes:\s/);
  });
});
