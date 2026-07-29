import type { TerminalKeyboardProtocolState } from "./keymap";

/// A coding agent whose terminal submit encoding chan knows. The SPA sends
/// only this identity; the server owns the submit bytes.
export type SubmitAgent = "claude" | "codex" | "gemini" | "opencode";

/// Infer an agent from the keyboard protocol a running TUI announced. This is
/// only a fallback for old servers and agents launched manually from a shell;
/// a current server reports the spawn-derived identity in its session frame.
/// OpenCode may announce the kitty protocol and classify as codex here, which
/// is byte-compatible with OpenCode's default encoding.
export function inferSubmitAgentFromKeyboardProtocol(
  protocol?: TerminalKeyboardProtocolState,
): SubmitAgent {
  if (protocol) {
    if (protocol.xtermModifyOtherKeys > 0) return "claude";
    const kittyFlags =
      protocol.kitty.screen === "alternate"
        ? protocol.kitty.alternateFlags
        : protocol.kitty.mainFlags;
    if (kittyFlags > 0) return "codex";
  }
  return "gemini";
}

/// Prefer the spawn-derived server identity and fall back to protocol
/// inference only when the session frame omitted it.
export function submitAgentForTerminal(
  serverAgent: SubmitAgent | undefined,
  protocol?: TerminalKeyboardProtocolState,
): SubmitAgent {
  return serverAgent ?? inferSubmitAgentFromKeyboardProtocol(protocol);
}
