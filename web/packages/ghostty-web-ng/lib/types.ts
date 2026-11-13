/**
 * Types the widget shares: ghostty-web's key numbering, which the input
 * handler encodes keys by and chan's binding translates to the core's, and
 * the link, buffer and event interfaces. The core itself is chan's binding
 * of libghostty-vt (`vt/ghosttyVt.ts`).
 */

// ============================================================================
// Key Encoder Types
// ============================================================================

/**
 * Key encoder options
 */
export enum KeyEncoderOption {
  CURSOR_KEY_APPLICATION = 0, // DEC mode 1
  KEYPAD_KEY_APPLICATION = 1, // DEC mode 66
  IGNORE_KEYPAD_WITH_NUMLOCK = 2, // DEC mode 1035
  ALT_ESC_PREFIX = 3, // DEC mode 1036
  MODIFY_OTHER_KEYS_STATE_2 = 4, // xterm modifyOtherKeys
  KITTY_KEYBOARD_FLAGS = 5, // Kitty protocol flags
}

/**
 * Key action
 */
export enum KeyAction {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}

/**
 * Physical key codes matching Ghostty's internal Key enum.
 * These values are used by Ghostty's key encoder to produce correct escape sequences.
 * Reference: ghostty/src/input/key.zig
 */
export enum Key {
  // Unidentified key
  UNIDENTIFIED = 0,

  // Writing System Keys
  GRAVE = 1, // ` and ~
  BACKSLASH = 2, // \ and |
  BRACKET_LEFT = 3, // [ and {
  BRACKET_RIGHT = 4, // ] and }
  COMMA = 5, // , and <
  ZERO = 6,
  ONE = 7,
  TWO = 8,
  THREE = 9,
  FOUR = 10,
  FIVE = 11,
  SIX = 12,
  SEVEN = 13,
  EIGHT = 14,
  NINE = 15,
  EQUAL = 16, // = and +
  INTL_BACKSLASH = 17,
  INTL_RO = 18,
  INTL_YEN = 19,
  A = 20,
  B = 21,
  C = 22,
  D = 23,
  E = 24,
  F = 25,
  G = 26,
  H = 27,
  I = 28,
  J = 29,
  K = 30,
  L = 31,
  M = 32,
  N = 33,
  O = 34,
  P = 35,
  Q = 36,
  R = 37,
  S = 38,
  T = 39,
  U = 40,
  V = 41,
  W = 42,
  X = 43,
  Y = 44,
  Z = 45,
  MINUS = 46, // - and _
  PERIOD = 47, // . and >
  QUOTE = 48, // ' and "
  SEMICOLON = 49, // ; and :
  SLASH = 50, // / and ?

  // Functional Keys
  ALT_LEFT = 51,
  ALT_RIGHT = 52,
  BACKSPACE = 53,
  CAPS_LOCK = 54,
  CONTEXT_MENU = 55,
  CONTROL_LEFT = 56,
  CONTROL_RIGHT = 57,
  ENTER = 58,
  META_LEFT = 59,
  META_RIGHT = 60,
  SHIFT_LEFT = 61,
  SHIFT_RIGHT = 62,
  SPACE = 63,
  TAB = 64,
  CONVERT = 65,
  KANA_MODE = 66,
  NON_CONVERT = 67,

  // Control Pad Section
  DELETE = 68,
  END = 69,
  HELP = 70,
  HOME = 71,
  INSERT = 72,
  PAGE_DOWN = 73,
  PAGE_UP = 74,

  // Arrow Pad Section
  DOWN = 75,
  LEFT = 76,
  RIGHT = 77,
  UP = 78,

  // Numpad Section
  NUM_LOCK = 79,
  KP_0 = 80,
  KP_1 = 81,
  KP_2 = 82,
  KP_3 = 83,
  KP_4 = 84,
  KP_5 = 85,
  KP_6 = 86,
  KP_7 = 87,
  KP_8 = 88,
  KP_9 = 89,
  KP_PLUS = 90, // Keypad +
  KP_BACKSPACE = 91,
  KP_CLEAR = 92,
  KP_CLEAR_ENTRY = 93,
  KP_COMMA = 94,
  KP_PERIOD = 95, // Keypad .
  KP_DIVIDE = 96, // Keypad /
  KP_ENTER = 97, // Keypad Enter
  KP_EQUAL = 98,
  KP_MEMORY_ADD = 99,
  KP_MEMORY_CLEAR = 100,
  KP_MEMORY_RECALL = 101,
  KP_MEMORY_STORE = 102,
  KP_MEMORY_SUBTRACT = 103,
  KP_MULTIPLY = 104, // Keypad *
  KP_PAREN_LEFT = 105,
  KP_PAREN_RIGHT = 106,
  KP_MINUS = 107, // Keypad -
  KP_SEPARATOR = 108,
  NUMPAD_UP = 109,
  NUMPAD_DOWN = 110,
  NUMPAD_RIGHT = 111,
  NUMPAD_LEFT = 112,
  NUMPAD_BEGIN = 113,
  NUMPAD_HOME = 114,
  NUMPAD_END = 115,
  NUMPAD_INSERT = 116,
  NUMPAD_DELETE = 117,
  NUMPAD_PAGE_UP = 118,
  NUMPAD_PAGE_DOWN = 119,

  // Function Keys
  ESCAPE = 120,
  F1 = 121,
  F2 = 122,
  F3 = 123,
  F4 = 124,
  F5 = 125,
  F6 = 126,
  F7 = 127,
  F8 = 128,
  F9 = 129,
  F10 = 130,
  F11 = 131,
  F12 = 132,
  F13 = 133,
  F14 = 134,
  F15 = 135,
  F16 = 136,
  F17 = 137,
  F18 = 138,
  F19 = 139,
  F20 = 140,
  F21 = 141,
  F22 = 142,
  F23 = 143,
  F24 = 144,
  F25 = 145,
  FN_LOCK = 146,
  PRINT_SCREEN = 147,
  SCROLL_LOCK = 148,
  PAUSE = 149,

  // Media Keys
  BROWSER_BACK = 150,
  BROWSER_FAVORITES = 151,
  BROWSER_FORWARD = 152,
  BROWSER_HOME = 153,
  BROWSER_REFRESH = 154,
  BROWSER_SEARCH = 155,
  BROWSER_STOP = 156,
  EJECT = 157,
  LAUNCH_APP_1 = 158,
  LAUNCH_APP_2 = 159,
  LAUNCH_MAIL = 160,
  MEDIA_PLAY_PAUSE = 161,
  MEDIA_SELECT = 162,
  MEDIA_STOP = 163,
  MEDIA_TRACK_NEXT = 164,
  MEDIA_TRACK_PREVIOUS = 165,
  POWER = 166,
  SLEEP = 167,
  AUDIO_VOLUME_DOWN = 168,
  AUDIO_VOLUME_MUTE = 169,
  AUDIO_VOLUME_UP = 170,
  WAKE_UP = 171,

  // Clipboard Keys
  COPY = 172,
  CUT = 173,
  PASTE = 174,
}

/**
 * Modifier keys
 */
export enum Mods {
  NONE = 0,
  SHIFT = 1 << 0,
  CTRL = 1 << 1,
  ALT = 1 << 2,
  SUPER = 1 << 3, // Windows/Command key
  CAPSLOCK = 1 << 4,
  NUMLOCK = 1 << 5,
}

/**
 * Key event structure
 */
export interface KeyEvent {
  action: KeyAction;
  key: Key;
  mods: Mods;
  consumedMods?: Mods;
  composing?: boolean;
  utf8?: string;
  unshiftedCodepoint?: number;
}

// ============================================================================
// Terminal Types
// ============================================================================

/**
 * RGB color
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Cursor position and visibility
 */
export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

// ============================================================================
// Link Detection System
// ============================================================================

/**
 * Represents a coordinate in the terminal buffer
 */
export interface IBufferCellPosition {
  x: number; // Column (0-based)
  y: number; // Row (0-based, absolute buffer position)
}

/**
 * Represents a range in the terminal buffer
 * Can span multiple lines for wrapped links
 */
export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition; // Inclusive
}

/**
 * Represents a detected link in the terminal
 */
export interface ILink {
  /** The URL or text of the link */
  text: string;

  /** The range of the link in the buffer (may span multiple lines) */
  range: IBufferRange;

  /** Called when the link is activated (clicked with modifier) */
  activate(event: MouseEvent): void;

  /** Optional: called when mouse enters/leaves the link */
  hover?(isHovered: boolean): void;

  /** Optional: called to clean up resources */
  dispose?(): void;
}

/**
 * Provides link detection for a specific type of link
 * Examples: OSC 8 hyperlinks, URL regex detection
 */
export interface ILinkProvider {
  /**
   * Provide links for a given row
   * @param y Absolute row in buffer (0-based)
   * @param callback Called with detected links (or undefined if none)
   */
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;

  /** Optional: called when terminal is disposed */
  dispose?(): void;
}

/**
 * Simplified buffer line interface for link providers
 */
export interface IBufferLine {
  /** Number of cells in this line */
  length: number;

  /** Get cell at position */
  getCell(x: number): IBufferCell;

  /** Get text content of the line */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/**
 * Simplified buffer cell interface for link providers
 */
export interface IBufferCell {
  /** Get the character codepoint */
  getCodepoint(): number;

  /** Get the hyperlink ID (0 = no link) */
  getHyperlinkId(): number;

  /** Get the width of the character (1 or 2 for wide chars) */
  getWidth(): number;

  /** Check if cell has specific flags */
  isBold(): boolean;
  isItalic(): boolean;
  isDim(): boolean;
}

/**
 * Simplified terminal buffer interface for link providers
 */
export interface IBuffer {
  /** Number of rows in the buffer (viewport + scrollback) */
  length: number;

  /** Get line at absolute buffer position */
  getLine(y: number): IBufferLine;
}

/**
 * Terminal buffer manager (active vs alternate screen)
 */
export interface IBufferManager {
  /** Currently active buffer */
  active: IBuffer;

  /** Normal screen buffer */
  normal: IBuffer;

  /** Alternate screen buffer (for fullscreen apps) */
  alternate: IBuffer;
}

/**
 * Event system interface (xterm.js compatible)
 */
export type IEvent<T> = (listener: (data: T) => void) => IDisposable;

export interface IDisposable {
  dispose(): void;
}

/**
 * Event emitter for custom events
 */
export class EventEmitter<T> {
  private listeners: Array<(data: T) => void> = [];

  /** Subscribe to events */
  public readonly event: IEvent<T> = (listener: (data: T) => void): IDisposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  /** Emit an event to all listeners */
  public fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  /** Remove all listeners */
  public dispose(): void {
    this.listeners = [];
  }
}

/**
 * Terminal mode identifiers
 *
 * ANSI modes (use with is_ansi = true):
 * - INSERT = 4
 *
 * DEC modes (use with is_ansi = false):
 * - CURSOR_VISIBLE = 25
 * - MOUSE_TRACKING_NORMAL = 1000
 * - MOUSE_TRACKING_BUTTON = 1002
 * - MOUSE_TRACKING_ANY = 1003
 * - FOCUS_EVENTS = 1004
 * - ALT_SCREEN = 1047
 * - ALT_SCREEN_WITH_CURSOR = 1049
 * - BRACKETED_PASTE = 2004
 */
export enum TerminalMode {
  // ANSI modes
  INSERT = 4,

  // DEC modes
  CURSOR_VISIBLE = 25,
  MOUSE_TRACKING_NORMAL = 1000,
  MOUSE_TRACKING_BUTTON = 1002,
  MOUSE_TRACKING_ANY = 1003,
  FOCUS_EVENTS = 1004,
  ALT_SCREEN = 1047,
  ALT_SCREEN_WITH_CURSOR = 1049,
  BRACKETED_PASTE = 2004,
}
