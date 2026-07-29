import { describe, expect, test } from "vitest";
import {
  inferSubmitAgentFromKeyboardProtocol,
  submitAgentForTerminal,
} from "./submitMode";
import { createTerminalKeyboardProtocolState } from "./keymap";

describe("submitMode", () => {
  test("server identity wins over keyboard-protocol fallback", () => {
    const protocol = createTerminalKeyboardProtocolState();
    protocol.xtermModifyOtherKeys = 1;
    expect(submitAgentForTerminal("opencode", protocol)).toBe("opencode");
    expect(submitAgentForTerminal(undefined, protocol)).toBe("claude");
  });

  test("protocol fallback keeps the existing claude/codex/gemini inference", () => {
    const protocol = createTerminalKeyboardProtocolState();
    expect(inferSubmitAgentFromKeyboardProtocol(protocol)).toBe("gemini");
    protocol.kitty.mainFlags = 8;
    expect(inferSubmitAgentFromKeyboardProtocol(protocol)).toBe("codex");
    protocol.xtermModifyOtherKeys = 1;
    expect(inferSubmitAgentFromKeyboardProtocol(protocol)).toBe("claude");
  });
});
