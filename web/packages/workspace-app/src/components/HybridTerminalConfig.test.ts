import { describe, expect, test } from "vitest";
import source from "./HybridTerminalConfig.svelte?raw";
import shell from "./HybridSurfaceConfigShell.svelte?raw";
import terminalSource from "./settings/TerminalSection.svelte?raw";

describe("HybridTerminalConfig back card", () => {
  test("it is shell-only and routes OK through onDone", () => {
    expect(source).toMatch(
      /let \{ onDone \}: \{ onDone\?: \(\) => void \} = \$props\(\)/,
    );
    expect(source).toMatch(
      /<HybridSurfaceConfigShell title="Hybrid Terminal" \{onDone\} \/>/,
    );
    expect(shell).toMatch(
      /<button type="button" class="config-ok" onclick=\{\(\) => onDone\?\.\(\)\}>OK<\/button>/,
    );
  });

  test("moved terminal controls no longer render or save from the card", () => {
    expect(source).not.toMatch(/hybrid-terminal-/);
    expect(source).not.toMatch(/fontDownloading/);
    expect(source).not.toMatch(/setFontChoice/);
    expect(source).not.toMatch(/updateGlobalConfigSerial/);
    expect(source).not.toMatch(/api\./);
  });
});

describe("Settings owns terminal controls", () => {
  test("Terminal section owns scrollback, TERM, MCP discovery, mouse capture, and font", () => {
    expect(terminalSource).toMatch(/label="Scrollback"/);
    expect(terminalSource).toMatch(/scrollback_mb: mb/);
    expect(terminalSource).toMatch(/default_term: value/);
    expect(terminalSource).toMatch(/mcp_env: on/);
    expect(terminalSource).toMatch(/mouse_capture: on/);
    expect(terminalSource).toMatch(/mouse_capture \?\? true/);
    expect(terminalSource).toMatch(/aria-label="Terminal font"/);
  });

  test("Source Code Pro still downloads before persisting terminal.font", () => {
    expect(terminalSource).toMatch(/api\.fontsSourceCodeProDownload\(\)/);
    expect(terminalSource).toMatch(/font: "source-code-pro"/);
    expect(terminalSource).toMatch(/font: "os-default"/);
  });
});
