import type { Terminal } from "@xterm/xterm";

type CsiParam = number | number[];
type FunctionIdentifier = {
  prefix?: string;
  intermediates?: string;
  final: string;
};
type ParserLike = {
  registerCsiHandler?: (
    id: FunctionIdentifier,
    callback: (params: CsiParam[]) => boolean | Promise<boolean>,
  ) => { dispose(): void };
  registerEscHandler?: (
    id: FunctionIdentifier,
    callback: () => boolean | Promise<boolean>,
  ) => { dispose(): void };
};

const KITTY_REPORT_ALL_KEYS = 8;
const XTERM_MODIFY_OTHER_KEYS = 4;
const STACK_LIMIT = 32;

export type TerminalKeyboardProtocolState = {
  xtermModifyOtherKeys: number;
  kitty: {
    screen: "main" | "alternate";
    mainFlags: number;
    alternateFlags: number;
    mainStack: number[];
    alternateStack: number[];
  };
};

export function createTerminalKeyboardProtocolState(): TerminalKeyboardProtocolState {
  return {
    xtermModifyOtherKeys: 0,
    kitty: {
      screen: "main",
      mainFlags: 0,
      alternateFlags: 0,
      mainStack: [],
      alternateStack: [],
    },
  };
}

export function terminalMetaKeyBytes(
  ev: KeyboardEvent,
  protocol?: TerminalKeyboardProtocolState,
): string | null {
  if (ev.type !== "keydown") return null;
  if (ev.key === "Enter" && !ev.altKey) {
    const modifier = enterModifier(ev);
    if (modifier !== null) {
      if (protocol?.xtermModifyOtherKeys) return `\x1b[27;${modifier};13~`;
      if ((currentKittyFlags(protocol) & KITTY_REPORT_ALL_KEYS) !== 0) {
        return `\x1b[13;${modifier}u`;
      }
      // Fallback for Shift+Enter when no enhanced keyboard protocol is
      // active. This is the "agent already running, never observed
      // negotiating" case: the agent enabled modifyOtherKeys/kitty before
      // this tab attached, so the negotiation is neither in the reattach
      // replay nor in the serialized snapshot, and the branches above see
      // a pristine state. Without this, Shift+Enter falls through to
      // xterm's plain `\r` and SUBMITS to the agent instead of inserting a
      // newline. A bare LF is the safe default across both foreground
      // programs: a plain shell's line discipline accepts `\n` exactly like
      // Enter (it submits the line, no stray bytes on the prompt), while
      // Claude Code reads `\n` as a newline inside its multi-line draft
      // (live-probed; the inverse of AGENT_SUBMIT_CHORD in submitMode.ts).
      // Scoped to Shift+Enter only: Cmd/Ctrl+Enter (modifiers 9/5) keep
      // falling through to `\r` so their submit semantics are preserved.
      if (modifier === 2) return "\n";
    }
  }
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return null;
  switch (ev.key) {
    case "ArrowLeft":
      return "\x1bb";
    case "ArrowRight":
      return "\x1bf";
    case "Backspace":
      return "\x1b\x7f";
    case "Delete":
      return "\x1bd";
    default:
      return null;
  }
}

export function handleTerminalMetaKey(
  ev: KeyboardEvent,
  sendInput: (data: string) => void,
  protocol?: TerminalKeyboardProtocolState,
): boolean {
  const bytes = terminalMetaKeyBytes(ev, protocol);
  if (bytes === null) return true;
  sendInput(bytes);
  ev.preventDefault();
  return false;
}

/// ghostty-web's current input encoder maps Enter with either no modifiers or
/// Shift to the same CR byte. Intercept only Shift+Enter and preserve chan's
/// fallback LF contract; all other keys keep flowing through Ghostty.
export function handleGhosttyShiftEnter(
  ev: KeyboardEvent,
  sendInput: (data: string) => void,
): boolean {
  if (
    ev.type !== "keydown" ||
    ev.key !== "Enter" ||
    !ev.shiftKey ||
    ev.ctrlKey ||
    ev.metaKey ||
    ev.altKey
  ) {
    return true;
  }
  sendInput("\n");
  ev.preventDefault();
  return false;
}

export function installKeyboardProtocolHandlers(
  term: Terminal,
  protocol: TerminalKeyboardProtocolState,
  sendGeneratedInput: (data: string) => void,
): void {
  const parser = (term as Terminal & { parser?: ParserLike }).parser;
  if (!parser?.registerCsiHandler) return;

  parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
    applyXtermModifierKeys(protocol, params);
    return true;
  });
  parser.registerCsiHandler({ prefix: ">", final: "n" }, (params) => {
    disableXtermModifierKeys(protocol, params);
    return true;
  });
  parser.registerCsiHandler({ prefix: "?", final: "m" }, (params) => {
    const reply = queryXtermModifierKeys(protocol, params);
    if (reply) sendGeneratedInput(reply);
    return true;
  });

  parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
    applyKittyKeyboardProtocol(protocol, "push", params);
    return true;
  });
  parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
    applyKittyKeyboardProtocol(protocol, "pop", params);
    return true;
  });
  parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
    applyKittyKeyboardProtocol(protocol, "set", params);
    return true;
  });
  parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    sendGeneratedInput(`\x1b[?${currentKittyFlags(protocol)}u`);
    return true;
  });

  parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    updateKittyScreen(protocol, params, "alternate");
    return false;
  });
  parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    updateKittyScreen(protocol, params, "main");
    return false;
  });
  parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
    resetTerminalKeyboardProtocolState(protocol);
    return false;
  });
  parser.registerEscHandler?.({ final: "c" }, () => {
    resetTerminalKeyboardProtocolState(protocol);
    return false;
  });
}

export function applyXtermModifierKeys(
  protocol: TerminalKeyboardProtocolState,
  params: CsiParam[],
): void {
  if (params.length === 0) {
    protocol.xtermModifyOtherKeys = 0;
    return;
  }
  if (numberParam(params[0]) !== XTERM_MODIFY_OTHER_KEYS) return;
  protocol.xtermModifyOtherKeys = Math.max(0, numberParam(params[1]) ?? 0);
}

export function disableXtermModifierKeys(
  protocol: TerminalKeyboardProtocolState,
  params: CsiParam[],
): void {
  if (params.length === 0 || numberParam(params[0]) === XTERM_MODIFY_OTHER_KEYS) {
    protocol.xtermModifyOtherKeys = 0;
  }
}

export function queryXtermModifierKeys(
  protocol: TerminalKeyboardProtocolState,
  params: CsiParam[],
): string | null {
  if (numberParam(params[0]) !== XTERM_MODIFY_OTHER_KEYS) return null;
  return `\x1b[>${XTERM_MODIFY_OTHER_KEYS};${protocol.xtermModifyOtherKeys}m`;
}

export function applyKittyKeyboardProtocol(
  protocol: TerminalKeyboardProtocolState,
  op: "push" | "pop" | "set",
  params: CsiParam[],
): void {
  if (op === "push") {
    pushKittyFlags(protocol);
    setCurrentKittyFlags(protocol, Math.max(0, numberParam(params[0]) ?? 0));
    return;
  }
  if (op === "pop") {
    const count = Math.max(1, numberParam(params[0]) ?? 1);
    popKittyFlags(protocol, count);
    return;
  }

  const flags = Math.max(0, numberParam(params[0]) ?? 0);
  const mode = numberParam(params[1]) ?? 1;
  const current = currentKittyFlags(protocol);
  if (mode === 2) {
    setCurrentKittyFlags(protocol, current | flags);
  } else if (mode === 3) {
    setCurrentKittyFlags(protocol, current & ~flags);
  } else {
    setCurrentKittyFlags(protocol, flags);
  }
}

export function resetTerminalKeyboardProtocolState(
  protocol: TerminalKeyboardProtocolState,
): void {
  protocol.xtermModifyOtherKeys = 0;
  protocol.kitty.screen = "main";
  protocol.kitty.mainFlags = 0;
  protocol.kitty.alternateFlags = 0;
  protocol.kitty.mainStack = [];
  protocol.kitty.alternateStack = [];
}

/// Compact snapshot of the negotiated state for the session hash. Only the
/// load-bearing flags survive (xterm modifyOtherKeys + kitty main/alt
/// flags + which screen is active); the transient push/pop stacks are
/// dropped and re-established by the reattach replay. Returns `null` when
/// everything is default so a plain shell never bloats the hash.
export type SerializedKeyboardProtocolState = {
  x?: number;
  km?: number;
  ka?: number;
  s?: "alt";
};

export function serializeKeyboardProtocolState(
  protocol: TerminalKeyboardProtocolState | undefined,
): SerializedKeyboardProtocolState | null {
  if (!protocol) return null;
  const snapshot: SerializedKeyboardProtocolState = {};
  if (protocol.xtermModifyOtherKeys > 0) snapshot.x = protocol.xtermModifyOtherKeys;
  if (protocol.kitty.mainFlags > 0) snapshot.km = protocol.kitty.mainFlags;
  if (protocol.kitty.alternateFlags > 0) snapshot.ka = protocol.kitty.alternateFlags;
  if (protocol.kitty.screen === "alternate") snapshot.s = "alt";
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/// Rebuild a protocol state from a session-hash snapshot. This is what
/// lets Shift+Enter -> newline survive a PAGE RELOAD reattaching to a
/// long-lived agent whose original negotiation has scrolled out of the
/// reattach replay ring (the case the in-memory tab state cannot cover,
/// since the page reload drops the heap).
export function restoreKeyboardProtocolState(
  snapshot: SerializedKeyboardProtocolState,
): TerminalKeyboardProtocolState {
  const protocol = createTerminalKeyboardProtocolState();
  protocol.xtermModifyOtherKeys = Math.max(0, snapshot.x ?? 0);
  protocol.kitty.mainFlags = Math.max(0, snapshot.km ?? 0);
  protocol.kitty.alternateFlags = Math.max(0, snapshot.ka ?? 0);
  protocol.kitty.screen = snapshot.s === "alt" ? "alternate" : "main";
  return protocol;
}

function enterModifier(ev: KeyboardEvent): number | null {
  if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) return 2;
  if (ev.ctrlKey && !ev.shiftKey && !ev.metaKey) return 5;
  if (ev.metaKey && !ev.shiftKey && !ev.ctrlKey) return 9;
  return null;
}

function currentKittyFlags(protocol?: TerminalKeyboardProtocolState): number {
  if (!protocol) return 0;
  return protocol.kitty.screen === "alternate"
    ? protocol.kitty.alternateFlags
    : protocol.kitty.mainFlags;
}

function setCurrentKittyFlags(
  protocol: TerminalKeyboardProtocolState,
  flags: number,
): void {
  if (protocol.kitty.screen === "alternate") {
    protocol.kitty.alternateFlags = flags;
  } else {
    protocol.kitty.mainFlags = flags;
  }
}

function currentKittyStack(protocol: TerminalKeyboardProtocolState): number[] {
  return protocol.kitty.screen === "alternate"
    ? protocol.kitty.alternateStack
    : protocol.kitty.mainStack;
}

function pushKittyFlags(protocol: TerminalKeyboardProtocolState): void {
  const stack = currentKittyStack(protocol);
  stack.push(currentKittyFlags(protocol));
  if (stack.length > STACK_LIMIT) stack.shift();
}

function popKittyFlags(
  protocol: TerminalKeyboardProtocolState,
  count: number,
): void {
  const stack = currentKittyStack(protocol);
  let restored: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const next = stack.pop();
    if (next === undefined) {
      restored = 0;
      break;
    }
    restored = next;
  }
  setCurrentKittyFlags(protocol, restored ?? currentKittyFlags(protocol));
}

function updateKittyScreen(
  protocol: TerminalKeyboardProtocolState,
  params: CsiParam[],
  screen: "main" | "alternate",
): void {
  if (params.some((param) => [47, 1047, 1049].includes(numberParam(param) ?? -1))) {
    protocol.kitty.screen = screen;
  }
}

function numberParam(param: CsiParam | undefined): number | null {
  if (typeof param === "number" && Number.isFinite(param)) return param;
  return null;
}
