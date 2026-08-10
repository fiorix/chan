import { describe, expect, test } from "vitest";
import terminal from "./HybridTerminalConfig.svelte?raw";
import terminalSettings from "./settings/TerminalSection.svelte?raw";
import carousel from "./EmptyPaneCarousel.svelte?raw";

// The Source Code Pro on/off control lives in Settings > Terminal, next to the
// other terminal-scoped settings. The terminal back card and Dashboard About
// slide carry neither the toggle nor the font attribution.

describe("Source Code Pro toggle placement", () => {
  test("Settings Terminal carries the Source Code Pro option + selectFont wiring", () => {
    expect(terminalSettings).toMatch(/<option value="source-code-pro">Source Code Pro<\/option>/);
    expect(terminalSettings).toMatch(/<option value="os-default">OS default \(mono\)<\/option>/);
    expect(terminalSettings).toMatch(/function selectFont\(/);
    // The face ships in the SPA bundle, so selecting it is a plain
    // preference write. Nothing to fetch means no state where the
    // config claims a font the browser cannot load.
    expect(terminalSettings).not.toMatch(/fontsSourceCodeProDownload/);
    expect(terminalSettings).toMatch(/terminal: \{ \.\.\.p\.terminal, font: next \}/);
  });

  test("Terminal back card does not carry the SCP toggle", () => {
    expect(terminal).not.toMatch(/value="source-code-pro"/);
    expect(terminal).not.toMatch(/fontsSourceCodeProDownload/);
    expect(terminal).not.toMatch(/selectFont/);
  });

  test("Dashboard About slide carries neither the SCP attribution nor the toggle", () => {
    // The terminal-font attribution + OFL link were dropped from the
    // About slide; the toggle lives in Settings.
    expect(carousel).not.toMatch(/Source Code Pro Regular/);
    expect(carousel).not.toMatch(
      /href="https:\/\/github\.com\/adobe-fonts\/source-code-pro\/blob\/release\/LICENSE\.md"/,
    );
    expect(carousel).not.toMatch(/setFontChoice\(/);
    expect(carousel).not.toMatch(/value="source-code-pro"/);
    expect(carousel).not.toMatch(/fontsSourceCodeProDownload/);
  });
});
