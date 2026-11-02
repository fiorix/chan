// Keyboard encoding for ghostty terminals follows xterm.js and chan's own
// key handling. Non-text keys after a dead key send their encoded bytes
// even when the browser emits no keypress for them; on Windows, a plain
// Enter's CR follows the dead key's character, which the browser types only
// after Enter's keydown.
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
  evaluateKeyboardEvent,
  xtermKeydown,
  type XtermKeydownInput,
  type XtermKeydownState,
  type XtermPlatform,
} from "./xtermKeyboard";

export type GhosttyKeyAction =
  | { kind: "send"; data: string }
  /// The browser keeps the key's default and types any pending dead-key text
  /// first; `data` is sent with the key's own line-break input.
  | { kind: "line-break"; data: string }
  /// Cancelled with nothing sent.
  | { kind: "cancel" }
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

/// A numpad digit typed with Alt alone held: on Windows, part of an Alt code.
function isAltCodeDigit(ev: Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && /^Numpad[0-9]$/.test(ev.code);
}

function isPlainEnter(ev: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return ev.key === "Enter" && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
}

/// One printable ASCII character other than the space, which stays Meta.
function isOptionAscii(key: string): boolean {
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  return code > 0x20 && code < 0x7f;
}

export type GhosttyKeyContext = {
  platform: XtermPlatform;
  applicationCursorMode: boolean;
  rows: number;
  /// What chan's xterm.js key handler sends for this event ahead of xterm.js,
  /// or null.
  chanBytes: string | null;
};

/// Decide one keydown with chan's key mapping and xterm.js's encoding.
export function ghosttyKeydownAction(
  ev: XtermKeydownInput & Pick<KeyboardEvent, "type">,
  ctx: GhosttyKeyContext,
  state: XtermKeydownState,
): GhosttyKeyAction {
  if (ev.type !== "keydown") return { kind: "ghostty" };
  // An IME owns the key; ghostty-web's own keydown returns early for it and
  // its composition listeners deliver the text.
  if (ev.isComposing || ev.keyCode === 229) return { kind: "ghostty" };
  // Windows types an Alt code's character when Alt is released, as browser
  // text. Its digits type nothing; with Num Lock off they read as arrows, and
  // Alt+ArrowLeft is the browser's Back, so they are cancelled ahead of chan's
  // own Alt+Arrow bytes.
  if (ctx.platform.isWindows && isAltCodeDigit(ev)) return { kind: "cancel" };
  if (ctx.chanBytes !== null) return { kind: "send", data: ctx.chanBytes };
  // Option is Meta on macOS, as chan runs xterm.js, except where a layout
  // puts a printable ASCII character on Option (@, [ and | on a German or a
  // French layout): that character types itself, as ghostty-web typed it.
  // A US layout keeps Meta: its Option characters are outside ASCII but for
  // Option+Shift+` (a backquote, where xterm.js sends ESC ~).
  if (ctx.platform.isMac && ev.altKey && !ev.ctrlKey && !ev.metaKey && isOptionAscii(ev.key)) {
    // Typing it ends a pending dead key, as any typed key does.
    state.deadKey = false;
    return { kind: "send", data: ev.key };
  }
  // Windows AltGraph is a modifier, not a pending dead-key composition.
  // Its next key either carries a layout character or encodes a Ctrl+Alt chord.
  if (ctx.platform.isWindows && ev.key === "AltGraph") return { kind: "browser" };
  // Windows Chromium types a dead key's pending character (an apostrophe on
  // US-International) only after Enter's keydown, and drops it when that
  // keydown is cancelled. Enter keeps its default, so the character comes
  // first and Enter's own line break follows it.
  if (ctx.platform.isWindows && state.deadKey && isPlainEnter(ev)) {
    state.deadKey = false;
    return { kind: "line-break", data: "\r" };
  }
  // Windows Chromium can supply the base key here and the composed text in
  // beforeinput, including two characters for an apostrophe then a consonant.
  if (ctx.platform.isWindows && state.deadKey && ghosttyTypesKey(ev)) {
    state.deadKey = false;
    return { kind: "browser" };
  }
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
      // types `ev.key` from keydown, so a key it would type is its to type: an
      // AltGr character, a dead key's composed character, a plain key.
      if (ghosttyTypesKey(ev)) {
        state.deadKey = false;
        // ghostty-web's Ctrl+KeyV paste early return also matches AltGr+V.
        if (ev.ctrlKey && ev.code === "KeyV") return { kind: "send", data: ev.key };
        return { kind: "ghostty" };
      }
      // A non-text key has no browser text to compose. Encode it even when
      // xterm.js's keydown deferred it for a pending dead key.
      if (decision.deadKey) {
        const data = evaluateKeyboardEvent(ev, ctx.applicationCursorMode, ctx.platform.isMac, true).key;
        if (data) {
          state.deadKey = false;
          return { kind: "send", data };
        }
      }
      return { kind: "browser" };
    case "composing":
      return { kind: "ghostty" };
  }
}

/// What chan's xterm.js path sends for the key behind a delete input:
/// Backspace, Delete, and their word chords (Option on macOS, where chan
/// treats Option as Meta, and Ctrl elsewhere). Null for any other input.
export function ghosttyDeleteInputBytes(inputType: string, platform: XtermPlatform): string | null {
  switch (inputType) {
    case "deleteContentBackward":
      return "\x7f";
    case "deleteContentForward":
      return "\x1b[3~";
    case "deleteWordBackward":
      return platform.isMac ? "\x1b\x7f" : "\b";
    case "deleteWordForward":
      return platform.isMac ? "\x1bd" : "\x1b[3;5~";
    default:
      return null;
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

/// Install the parity listeners on `host`, the element ghostty-web was opened
/// in. Returns their removal.
export function installGhosttyKeyParity(host: HTMLElement, deps: GhosttyKeyDeps): () => void {
  const state = createXtermKeydownState();
  let pendingText: string | null = null;
  let composing = false;
  // A key left to the browser whose bytes go with its line-break input. If
  // that input never comes, the key's keyup, focus loss or the next keydown
  // sends them, so the key is not lost.
  let lineBreak: { code: string; data: string } | null = null;
  const sendLineBreak = (): void => {
    if (!lineBreak) return;
    const { data } = lineBreak;
    lineBreak = null;
    deps.terminal.clearSelection();
    deps.send(data);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    sendLineBreak();
    pendingText = null;
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
        if (!composing && !e.isComposing && e.keyCode !== 229 && ghosttyTypesKey(e)) pendingText = e.key;
        return;
      case "send":
        // As xterm.js and ghostty-web both do for typed input.
        term.clearSelection();
        deps.send(action.data);
        pendingText = e.key.length === 1 ? e.key : action.data;
        break;
      case "line-break":
        lineBreak = { code: e.code, data: action.data };
        e.stopImmediatePropagation();
        return;
      case "cancel":
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
  const onKeyup = (e: KeyboardEvent): void => {
    pendingText = null;
    if (lineBreak?.code === e.code) sendLineBreak();
  };
  const onFocusout = (): void => {
    pendingText = null;
    sendLineBreak();
  };
  const onCompositionStart = (): void => {
    composing = true;
    pendingText = null;
  };
  const onCompositionEnd = (e: CompositionEvent): void => {
    composing = false;
    state.deadKey = false;
    // ghostty-web sends the commit. Some input sources also emit insertText
    // for that same commit before the next key event.
    pendingText = e.data;
  };
  const onBeforeInput = (e: InputEvent): void => {
    // The pending key's own input, on the host or ghostty-web's textarea,
    // after any dead-key text the browser typed ahead of it.
    if (lineBreak && !e.defaultPrevented && (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak")) {
      sendLineBreak();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // A delete whose keydown the browser's text input took (WebKit flags it
    // keyCode 229, and both keydown paths leave it alone) arrives as delete
    // input. ghostty-web reads it only on its textarea and has no word
    // deletes, while focus() puts the focus on the host, so every delete
    // aimed at either is sent here as its key, once. A composition's own
    // deletes stay with the composition.
    const deleteBytes = ghosttyDeleteInputBytes(e.inputType, deps.platform());
    if (deleteBytes !== null) {
      const aimed = e.target === host || (e.target instanceof HTMLTextAreaElement && e.target.parentElement === host);
      if (!aimed || e.defaultPrevented || composing || e.isComposing) return;
      const duplicate = pendingText === deleteBytes;
      pendingText = null;
      if (!duplicate) {
        deps.terminal.clearSelection();
        deps.send(deleteBytes);
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // ghostty-web owns textarea text input and composition. Its host listener
    // only cancels beforeinput, so text aimed at the focused host goes here.
    if (e.target !== host || e.defaultPrevented || composing || e.isComposing || e.inputType !== "insertText" || !e.data) return;
    const duplicate = pendingText === e.data;
    pendingText = null;
    state.deadKey = false;
    if (!duplicate) {
      deps.terminal.clearSelection();
      deps.send(e.data.replace(/\n/g, "\r"));
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  host.addEventListener("keydown", onKeydown, true);
  host.addEventListener("keyup", onKeyup, true);
  host.addEventListener("focusout", onFocusout, true);
  host.addEventListener("compositionstart", onCompositionStart, true);
  host.addEventListener("compositionend", onCompositionEnd, true);
  host.addEventListener("beforeinput", onBeforeInput, true);
  return () => {
    host.removeEventListener("keydown", onKeydown, true);
    host.removeEventListener("keyup", onKeyup, true);
    host.removeEventListener("focusout", onFocusout, true);
    host.removeEventListener("compositionstart", onCompositionStart, true);
    host.removeEventListener("compositionend", onCompositionEnd, true);
    host.removeEventListener("beforeinput", onBeforeInput, true);
  };
}
