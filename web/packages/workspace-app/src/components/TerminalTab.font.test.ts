import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import tab from "./TerminalTab.svelte?raw";
import main from "../main.ts?raw";

// `?raw` returns an empty string for `.css` imports under the JSDOM
// vitest setup (the CSS plugin chain consumes them); read the file
// from disk relative to the vitest cwd (= web/) instead.
const fonts = readFileSync("src/fonts.css", "utf8");

// TerminalTab ships Source Code Pro Regular and defaults renderers to a
// non-blinking block cursor at 14 px. Per-OS native mono leads the
// fontFamily chain; SCP appears after the OS-native faces and activates
// only when the user opts in via Settings.

describe("TerminalTab font + cursor parity", () => {
  test("OS-default font chain leads with per-OS native mono and trails with Source Code Pro", () => {
    // The literal fontFamily string lives in a named constant so the
    // pref-driven swap can pick between two chains.
    expect(tab).toMatch(
      /FONT_CHAIN_OS_DEFAULT\s*=\s*'"SF Mono",[^']*?"Cascadia Code"[^']*?"DejaVu Sans Mono"[^']*?"Source Code Pro"/,
    );
  });

  test("Source Code Pro font chain leads with SCP when the user opts in", () => {
    expect(tab).toMatch(
      /FONT_CHAIN_SOURCE_CODE_PRO\s*=\s*'"Source Code Pro",[^']*?"SF Mono"/,
    );
  });

  test("fontFamily reads the persisted preference at spawn time", () => {
    // The preference is read once at spawn; existing terminals keep
    // their font until session restart.
    expect(tab).toMatch(
      /workspace\.info\?\.preferences\?\.terminal\?\.font\s*\?\?\s*"os-default"/,
    );
    expect(tab).toMatch(
      /fontPref === "source-code-pro"\s*\?\s*FONT_CHAIN_SOURCE_CODE_PRO\s*:\s*FONT_CHAIN_OS_DEFAULT/,
    );
  });

  test("fontSize is captured once for both backends and cell measurement", () => {
    expect(tab).toMatch(
      /const rendererFontSize = terminalPrefs\?\.font_size \?\? 14;/,
    );
    expect(tab.match(/fontSize:\s*rendererFontSize,/g)).toHaveLength(2);
    expect(tab).toMatch(
      /measureXtermCellDimensions\([\s\S]*?fontFamily,\s*rendererFontSize,\s*1\.2/,
    );
    expect(tab).not.toMatch(/fontSize:\s*14,/);
  });

  test("cursor is non-blinking block per iTerm defaults", () => {
    expect(tab).toMatch(/cursorBlink:\s*false,/);
    expect(tab).toMatch(/cursorStyle:\s*"block",/);
  });

  test("@font-face declaration points at the rust-embed-served path", () => {
    expect(fonts).toMatch(/font-family:\s*['"]Source Code Pro['"]/);
    expect(fonts).toMatch(/font-weight:\s*400/);
    expect(fonts).toMatch(
      /url\(['"]?\/static\/fonts\/SourceCodePro-Regular\.otf\.woff2['"]?\)/,
    );
    expect(fonts).toMatch(/font-display:\s*swap/);
  });

  test("fonts.css is imported at app boot so the face starts loading early", () => {
    expect(main).toMatch(/import\s+"\.\/fonts\.css"/);
  });
});
