import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import tab from "./TerminalTab.svelte?raw";
import main from "../main.ts?raw";

// `?raw` returns an empty string for `.css` imports under the JSDOM
// vitest setup (the CSS plugin chain consumes them); read the file
// from disk relative to the vitest cwd (= packages/workspace-app)
// instead.
const fonts = readFileSync("src/fonts.css", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");

// TerminalTab ships Source Code Pro Regular and defaults renderers to a
// non-blinking block cursor at 14 px. The os-default chain is per-OS:
// macOS and Windows lead with their native mono, Linux leads with the
// bundled face because it has no single native mono to lead with.

describe("TerminalTab font + cursor parity", () => {
  test("os-default chain leads with native mono on macOS and Windows", () => {
    expect(tab).toMatch(/mac:\s*'"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace'/);
    expect(tab).toMatch(/windows:\s*\n?\s*'"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace'/);
  });

  test("os-default chain leads with the bundled face on Linux", () => {
    // The parity fix. Without this, Linux lands on whatever fontconfig
    // installed first (DejaVu Sans Mono on most distros) and the same
    // session looks nothing like the macOS one.
    expect(tab).toMatch(/linux:\s*\n?\s*'"Source Code Pro", ui-monospace,/);
  });

  test("ui-monospace never precedes the bundled face on Linux", () => {
    // Ahead of it, `ui-monospace` resolves to the fontconfig monospace
    // and Source Code Pro can never win, which silently undoes the fix.
    const linuxChain = tab.match(/linux:\s*\n?\s*'([^']*)'/)?.[1] ?? "";
    expect(linuxChain).not.toBe("");
    expect(linuxChain.indexOf('"Source Code Pro"')).toBeLessThan(
      linuxChain.indexOf("ui-monospace"),
    );
  });

  test("opting into Source Code Pro promotes it without duplicating it", () => {
    expect(tab).toMatch(
      /fontPref === "source-code-pro" && !osChain\.startsWith\(SOURCE_CODE_PRO\)/,
    );
  });

  test("fontFamily reads the persisted preference at spawn time", () => {
    // The preference is read once at spawn; existing terminals keep
    // their font until session restart.
    expect(tab).toMatch(
      /currentPreferences\(\)\?\.terminal\?\.font\s*\?\?\s*"os-default"/,
    );
    expect(tab).toMatch(/const osChain = FONT_CHAIN_OS_DEFAULT\[currentOS\(\)\]/);
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

  test("@font-face src is relative so it resolves under a tenant prefix", () => {
    // WorkspaceHost mounts each tenant under a single-segment slug, and
    // vite builds with base "./" for exactly that reason. An absolute
    // `/static/...` src resolves against the origin root instead, where
    // the launcher root fallback answers with index.html and the face
    // fails to decode with no visible error.
    expect(fonts).toMatch(/font-family:\s*['"]Source Code Pro['"]/);
    expect(fonts).toMatch(/font-weight:\s*400/);
    expect(fonts).toMatch(
      /url\(['"]\.\/fonts\/SourceCodePro-Regular\.otf\.woff2['"]\)/,
    );
    expect(fonts).not.toMatch(/url\(['"]?\//);
    expect(fonts).toMatch(/font-display:\s*swap/);
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
    expect(viteConfig).toMatch(/join\(options\.dir, "static\/fonts\/OFL\.txt"\)/);
  });

  test("fonts.css is imported at app boot so the face starts loading early", () => {
    expect(main).toMatch(/import\s+"\.\/fonts\.css"/);
  });
});
