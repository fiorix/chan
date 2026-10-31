// Keyboard parity for ghostty terminals: a ghostty terminal sends what an
// xterm.js terminal sends for the same keydown, chan's own key handling
// included.
//
// ghostty-web encodes keys differently from xterm.js. Among other things it
// never prefixes Alt with ESC (Alt+B sends "b"), passes no text to the encoder
// for a macOS Option character (Option+B sends nothing), drops Shift from
// Home, End, Delete and the function keys, and encodes Ctrl+[ as CSI 91;5u.
// chan's xterm.js path also maps Alt+Left/Right and Alt+Delete to the
// readline word motions and treats Option as Meta on macOS.
//
// A capture-phase keydown listener on the terminal's host decides each key
// before ghostty-web's bubble-phase listener sees it:
// - keys chan claims as its own chords flow on to ghostty-web, whose custom
//   key handler is chan's;
// - keys xterm.js would encode are sent here and stopped;
// - plain typing, which ghostty-web types exactly as xterm.js does, flows on;
// - keys xterm.js leaves to the browser (a dead key, Shift+Insert paste, an
//   unclaimed macOS Command chord) are stopped before ghostty-web without
//   losing their default, so the browser's input, composition, paste and
//   native menu handling still run.

import {
  createXtermKeydownState,
  xtermKeydown,
  type XtermKeydownInput,
  type XtermKeydownState,
  type XtermPlatform,
} from "./xtermKeyboard";

export type GhosttyKeyAction =
  | { kind: "send"; data: string }
  | { kind: "scroll"; lines: number }
  | { kind: "select-all" }
  | { kind: "ghostty" }
  | { kind: "browser" };

/// Whether ghostty-web's keydown types `ev.key` itself (its
/// isPrintableCharacter): one character with no Ctrl or Alt alone and no
/// Meta. Ctrl and Alt together count, as Windows reports AltGr that way.
export function ghosttyTypesKey(ev: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">): boolean {
  if ((ev.ctrlKey && !ev.altKey) || (ev.altKey && !ev.ctrlKey) || ev.metaKey) return false;
  return ev.key.length === 1;
}

export type GhosttyKeyContext = {
  platform: XtermPlatform;
  applicationCursorMode: boolean;
  rows: number;
  /// What chan's xterm.js key handler sends for this event ahead of xterm.js,
  /// or null.
  chanBytes: string | null;
};

/// Decide one keydown the way chan's xterm.js terminal does.
export function ghosttyKeydownAction(
  ev: XtermKeydownInput & Pick<KeyboardEvent, "type">,
  ctx: GhosttyKeyContext,
  state: XtermKeydownState,
): GhosttyKeyAction {
  if (ev.type !== "keydown") return { kind: "ghostty" };
  // An IME owns the key; ghostty-web's own keydown returns early for it and
  // its composition listeners deliver the text.
  if (ev.isComposing || ev.keyCode === 229) return { kind: "ghostty" };
  if (ctx.chanBytes !== null) return { kind: "send", data: ctx.chanBytes };
  const decision = xtermKeydown(
    ev,
    { applicationCursorMode: ctx.applicationCursorMode, platform: ctx.platform, rows: ctx.rows },
    state,
  );
  switch (decision.kind) {
    case "send":
      return decision.data === ev.key && ghosttyTypesKey(ev)
        ? { kind: "ghostty" }
        : { kind: "send", data: decision.data };
    case "scroll":
      return { kind: "scroll", lines: decision.lines };
    case "select-all":
      return { kind: "select-all" };
    case "pass":
      // xterm.js types a key it leaves to the browser from its keypress or
      // input handler, which also ends a pending dead key or AltGr. ghostty-web
      // types `ev.key` from keydown and never sees the browser's own text while
      // its host holds the focus, so a key it would type is its to type: an
      // AltGr character, a dead key's composed character, a plain key.
      if (ghosttyTypesKey(ev)) {
        state.deadKey = false;
        return { kind: "ghostty" };
      }
      return { kind: "browser" };
    case "composing":
      return { kind: "ghostty" };
  }
}

/// The slice of ghostty-web's Terminal the listener drives.
export type GhosttyKeyTerminal = {
  readonly rows: number;
  getMode(mode: number): boolean;
  scrollLines(amount: number): void;
  selectAll(): void;
  clearSelection(): void;
};

export type GhosttyKeyDeps = {
  terminal: GhosttyKeyTerminal;
  platform(): XtermPlatform;
  /// A chord chan acts on itself (copy, paste, a shortcut that escapes the
  /// terminal, closing an exited tab). Its handling stays in the custom key
  /// handler ghostty-web calls.
  claimed(e: KeyboardEvent): boolean;
  /// chan's own key handling ahead of xterm.js (see GhosttyKeyContext).
  chanBytes(e: KeyboardEvent): string | null;
  /// Send keyboard input to the PTY.
  send(data: string): void;
};

/// DEC private mode 1, application cursor keys (DECCKM).
const DECCKM = 1;

/// Install the parity listener on `host`, the element ghostty-web was opened
/// in. Returns its removal.
export function installGhosttyKeyParity(host: HTMLElement, deps: GhosttyKeyDeps): () => void {
  const state = createXtermKeydownState();
  const onKeydown = (e: KeyboardEvent): void => {
    if (deps.claimed(e)) return;
    const term = deps.terminal;
    const action = ghosttyKeydownAction(
      e,
      {
        platform: deps.platform(),
        applicationCursorMode: term.getMode(DECCKM),
        rows: term.rows,
        chanBytes: deps.chanBytes(e),
      },
      state,
    );
    switch (action.kind) {
      case "ghostty":
        return;
      case "send":
        // As xterm.js and ghostty-web both do for typed input.
        term.clearSelection();
        deps.send(action.data);
        break;
      case "scroll":
        term.scrollLines(action.lines);
        break;
      case "select-all":
        term.selectAll();
        e.stopImmediatePropagation();
        return;
      case "browser":
        e.stopImmediatePropagation();
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  host.addEventListener("keydown", onKeydown, true);
  return () => host.removeEventListener("keydown", onKeydown, true);
}
