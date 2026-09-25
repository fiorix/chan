import { describe, expect, test } from "vitest";
import terminal from "./TerminalTab.svelte?raw";

describe("TerminalTab generated reply routing", () => {
  test("installs xterm OSC color report guards", () => {
    expect(terminal).toContain(
      'import { installTerminalReportGuards } from "../terminal/xtermReports";',
    );
    // The keyboard-protocol state lives on the tab (survives a remount on
    // reattach); start() resets it only on a fresh spawn, then installs
    // the report guards on the xterm branch (the ghostty backend's WASM
    // parser owns device reports itself).
    expect(terminal).toMatch(
      /const keyboardProtocol = ensureTerminalKeyboardProtocol\([\s\S]*?\);[\s\S]*?term = new Terminal\([\s\S]*?\);\s*installTerminalReportGuards\(term\);/,
    );
  });

  test("installs keyboard protocol tracking before xterm input handlers", () => {
    expect(terminal).toMatch(
      /installKeyboardProtocolHandlers\(term, keyboardProtocol, sendGeneratedTerminalInput\);[\s\S]*?term\.attachCustomKeyEventHandler\(handleTerminalKeyEvent\);/,
    );
  });

  test("PTY output uses a tracked xterm write", () => {
    expect(terminal).toContain("PtyWriteTracker");
    expect(terminal).toContain("const ptyWrites = new PtyWriteTracker();");
    expect(terminal).toMatch(
      /function writePtyOutput\(bytes: Uint8Array, origin: PtyWriteOrigin = "live"\): void \{[\s\S]*?writeParsedPtyOutput\(bytes, origin\);/,
    );
    expect(terminal).toMatch(
      /function writeParsedPtyOutput\([\s\S]*?ptyWrites\.write\(termWriter, bytes, origin,/,
    );
    expect(terminal).toMatch(/const bytes = await terminalMessageBytes\(event\.data\);[\s\S]*?writePtyOutput\(bytes, attachPtyWriteOrigin\(\)\);/);
  });

  test("xterm-generated replies bypass broadcast fan-out", () => {
    expect(terminal).toContain("term.onData(handleXtermData);");
    expect(terminal).toMatch(
      /function handleXtermData\(data: string\): void \{[\s\S]*?routeXtermData\(data, ptyWrites, sendInput, sendUserInput\);/,
    );
  });

  test("suppresses duplicate reattach replay replies without blocking live replies", () => {
    // Full reattach replay feeds historical PTY queries into a brand-new
    // xterm. Re-answering those old queries leaks raw CPR/DA/DCS reply bytes
    // into the shell prompt after refresh, so only duplicate replay-origin
    // generated replies are suppressed; live output still answers through
    // the owning PTY and bypasses broadcast.
    expect(terminal).toContain("let attachReplayActive = false;");
    expect(terminal).toContain("let suppressAttachReplayGeneratedReplies = false;");
    expect(terminal).toMatch(
      /const duplicateReplay = reattaching && !sawSessionControl;[\s\S]*?attachReplayActive = true;[\s\S]*?suppressAttachReplayGeneratedReplies = duplicateReplay;/,
    );
    expect(terminal).toMatch(
      /frame\.type === "ready"[\s\S]*?attachReplayActive = false;[\s\S]*?suppressAttachReplayGeneratedReplies = false;/,
    );
    expect(terminal).toContain("shouldForwardGeneratedTerminalInput(ptyWrites)");
    expect(terminal).toContain("routeXtermData(data, ptyWrites, sendInput, sendUserInput);");
  });
});
