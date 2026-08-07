import { describe, expect, test, vi } from "vitest";
import {
  applyKittyKeyboardProtocol,
  applyXtermModifierKeys,
  createTerminalKeyboardProtocolState,
  disableXtermModifierKeys,
  handleGhosttyShiftEnter,
  handleTerminalMetaKey,
  queryXtermModifierKeys,
  resetTerminalKeyboardProtocolState,
  restoreKeyboardProtocolState,
  serializeKeyboardProtocolState,
  terminalMetaKeyBytes,
} from "./keymap";

function keyEvent(init: KeyboardEventInit & { type?: string }): KeyboardEvent {
  const { type = "keydown", ...eventInit } = init;
  return new KeyboardEvent(type, {
    cancelable: true,
    ...eventInit,
  });
}

describe("terminal meta key mapping", () => {
  test.each([
    ["ArrowLeft", "\x1bb"],
    ["ArrowRight", "\x1bf"],
    ["Backspace", "\x1b\x7f"],
    ["Delete", "\x1bd"],
  ])("maps Alt+%s to readline bytes", (key, bytes) => {
    expect(terminalMetaKeyBytes(keyEvent({ key, altKey: true }))).toBe(bytes);
  });

  test("leaves non-target keys and modified chords to xterm", () => {
    expect(terminalMetaKeyBytes(keyEvent({ key: "d", altKey: true }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ key: "ArrowLeft", altKey: true, ctrlKey: true }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ key: "ArrowLeft", altKey: true, metaKey: true }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ key: "ArrowLeft" }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ type: "keyup", key: "ArrowLeft", altKey: true }))).toBeNull();
  });

  test("Shift+Enter falls back to LF when no enhanced keyboard reporting is active (SUBMIT)", () => {
    // The "agent already running, never observed negotiating" case:
    // nothing negotiated, nothing restored. Shift+Enter must insert a
    // newline (a bare LF: newline in an agent draft, harmless submit in a
    // plain shell), NOT fall through to xterm's submit `\r`. Cmd/Ctrl+Enter
    // keep falling through so their submit semantics are preserved.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }))).toBe("\n");
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", ctrlKey: true }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", metaKey: true }))).toBeNull();
  });

  test("maps modified Enter to xterm modifyOtherKeys while that mode is active", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyXtermModifierKeys(protocol, [4, 2]);

    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe(
      "\x1b[27;2;13~",
    );
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", ctrlKey: true }), protocol)).toBe(
      "\x1b[27;5;13~",
    );
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", metaKey: true }), protocol)).toBe(
      "\x1b[27;9;13~",
    );
    expect(
      terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true, ctrlKey: true }), protocol),
    ).toBeNull();
  });

  test("maps modified Enter to CSI-u when kitty report-all-keys is active", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyKittyKeyboardProtocol(protocol, "push", [8]);

    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe(
      "\x1b[13;2u",
    );
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", ctrlKey: true }), protocol)).toBe(
      "\x1b[13;5u",
    );
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", metaKey: true }), protocol)).toBe(
      "\x1b[13;9u",
    );
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", ctrlKey: true, metaKey: true }))).toBeNull();
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", altKey: true }))).toBeNull();
  });

  test("does not treat kitty disambiguate-only mode as report-all Enter mode", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyKittyKeyboardProtocol(protocol, "push", [1]);

    // Disambiguate-only (flag 1, not REPORT_ALL_KEYS 8) must not emit the
    // CSI-u report-all sequence; it falls to the Shift+Enter LF fallback.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");
  });

  test("sends matched bytes and suppresses xterm default handling", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "Backspace", altKey: true });

    expect(handleTerminalMetaKey(ev, sendInput)).toBe(false);
    expect(sendInput).toHaveBeenCalledWith("\x1b\x7f");
    expect(ev.defaultPrevented).toBe(true);
  });

  test("returns true without sending for keys xterm should handle", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "d", altKey: true });

    expect(handleTerminalMetaKey(ev, sendInput)).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  test("Shift+Enter sends the LF fallback and suppresses xterm submit", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "Enter", shiftKey: true });

    expect(handleTerminalMetaKey(ev, sendInput)).toBe(false);
    expect(sendInput).toHaveBeenCalledWith("\n");
    expect(ev.defaultPrevented).toBe(true);
  });

  test("passes Cmd/Ctrl+Enter through to xterm when no foreground app requested it", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "Enter", ctrlKey: true });

    expect(handleTerminalMetaKey(ev, sendInput)).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  test("Ghostty Shift+Enter sends LF instead of its plain Enter CR", () => {
    const sendInput = vi.fn();
    const ev = keyEvent({ key: "Enter", shiftKey: true });

    expect(handleGhosttyShiftEnter(ev, sendInput)).toBe(false);
    expect(sendInput).toHaveBeenCalledWith("\n");
    expect(ev.defaultPrevented).toBe(true);
  });

  test("Ghostty leaves other Enter chords and keyup events untouched", () => {
    const sendInput = vi.fn();
    expect(
      handleGhosttyShiftEnter(
        keyEvent({ key: "Enter", ctrlKey: true }),
        sendInput,
      ),
    ).toBe(true);
    expect(
      handleGhosttyShiftEnter(
        keyEvent({ type: "keyup", key: "Enter", shiftKey: true }),
        sendInput,
      ),
    ).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  test("xterm modifyOtherKeys supports query and disable", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyXtermModifierKeys(protocol, [4, 2]);

    expect(queryXtermModifierKeys(protocol, [4])).toBe("\x1b[>4;2m");
    disableXtermModifierKeys(protocol, [4]);
    expect(queryXtermModifierKeys(protocol, [4])).toBe("\x1b[>4;0m");
    // modifyOtherKeys back off -> Shift+Enter drops to the LF fallback,
    // not a submit `\r`.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");
  });

  test("kitty keyboard protocol push, pop, and flag edits are scoped to the active screen", () => {
    const protocol = createTerminalKeyboardProtocolState();

    applyKittyKeyboardProtocol(protocol, "push", [8]);
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe(
      "\x1b[13;2u",
    );

    protocol.kitty.screen = "alternate";
    // No report-all on the alternate screen -> Shift+Enter LF fallback.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");
    applyKittyKeyboardProtocol(protocol, "set", [8, 2]);
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe(
      "\x1b[13;2u",
    );
    applyKittyKeyboardProtocol(protocol, "set", [8, 3]);
    // Flag 8 cleared on the alternate screen -> back to the LF fallback.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");

    protocol.kitty.screen = "main";
    applyKittyKeyboardProtocol(protocol, "pop", []);
    // Popped back to the pristine main-screen flags -> LF fallback.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");
  });

  test("terminal reset clears negotiated keyboard modes", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyXtermModifierKeys(protocol, [4, 2]);
    applyKittyKeyboardProtocol(protocol, "push", [8]);

    resetTerminalKeyboardProtocolState(protocol);

    expect(queryXtermModifierKeys(protocol, [4])).toBe("\x1b[>4;0m");
    // Reset wipes every negotiated mode -> Shift+Enter LF fallback.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe("\n");
  });

  test("default state serializes to null (plain shell keeps the hash clean)", () => {
    expect(serializeKeyboardProtocolState(createTerminalKeyboardProtocolState())).toBeNull();
    expect(serializeKeyboardProtocolState(undefined)).toBeNull();
  });

  test("negotiated state survives a serialize/restore round-trip", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyXtermModifierKeys(protocol, [4, 2]);
    // Shift+Enter -> modifyOtherKeys sequence before the round-trip.
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), protocol)).toBe(
      "\x1b[27;2;13~",
    );

    const snapshot = serializeKeyboardProtocolState(protocol);
    expect(snapshot).toEqual({ x: 2 });

    // A reload reattaching to a long-lived agent rebuilds from the
    // snapshot; Shift+Enter must still emit the sequence, not submit.
    const restored = restoreKeyboardProtocolState(snapshot!);
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), restored)).toBe(
      "\x1b[27;2;13~",
    );
  });

  test("kitty flags + alternate screen round-trip", () => {
    const protocol = createTerminalKeyboardProtocolState();
    applyKittyKeyboardProtocol(protocol, "set", [8]); // REPORT_ALL_KEYS on main
    protocol.kitty.screen = "alternate";
    applyKittyKeyboardProtocol(protocol, "set", [8]); // and on alternate

    const snapshot = serializeKeyboardProtocolState(protocol);
    expect(snapshot).toEqual({ km: 8, ka: 8, s: "alt" });

    const restored = restoreKeyboardProtocolState(snapshot!);
    expect(restored.kitty.screen).toBe("alternate");
    expect(terminalMetaKeyBytes(keyEvent({ key: "Enter", shiftKey: true }), restored)).toBe(
      "\x1b[13;2u",
    );
  });
});
