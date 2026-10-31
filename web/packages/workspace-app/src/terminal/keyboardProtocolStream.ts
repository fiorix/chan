// The keyboard protocol state of a ghostty terminal, followed from its output.
//
// chan's xterm.js terminals follow the program's xterm modifyOtherKeys and
// kitty keyboard requests through parser hooks (keymap.ts
// installKeyboardProtocolHandlers), and the modified-Enter encoding reads the
// result. ghostty-web exposes no parser hooks, so this observer reads the
// same sequences from the bytes on their way into the VT and applies them
// with the same function. It never alters the stream.
//
// The grammar is xterm.js's (common/parser/EscapeSequenceParser.ts) for what
// the state depends on: CSI with its prefix, params, sub-params and
// intermediates, and ESC c (RIS). Every other sequence, the string ones (OSC,
// DCS, APC and the like) included, can be read as plain text: only an ESC
// starts what the state follows, and an ESC inside a string ends the string
// in xterm.js too. keyboardProtocolStream.test.ts runs the same streams
// through xterm.js's parser. The 8-bit C1 introducers are not followed;
// programs in a UTF-8 terminal use the 7-bit ESC forms.

import {
  applyKeyboardProtocolCsi,
  resetTerminalKeyboardProtocolState,
  type TerminalKeyboardProtocolState,
} from "./keymap";

type CsiParam = number | number[];

type State = "ground" | "escape" | "csi-entry" | "csi-param" | "csi-intermediate" | "csi-ignore";

/// xterm.js's limits (common/parser/Params.ts), which also bound the memory a
/// long sequence can take.
const MAX_PARAMS = 32;
const MAX_SUB_PARAMS = 32;
const MAX_VALUE = 0x7fffffff;

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;

export class KeyboardProtocolObserver {
  private state: State = "ground";
  private prefix = "";
  private intermediates = "";
  /// Params as xterm.js's Params.toArray() gives them: each param, followed
  /// by its sub-params as an array when it has any.
  private params: number[] = [];
  private subParams: number[][] = [];
  /// xterm.js's Params bookkeeping: whether digits extend a sub-param, the
  /// sub-param count over the whole sequence, and the overflow rejections.
  private digitIsSub = false;
  private subParamCount = 0;
  private rejectDigits = false;
  private rejectSubDigits = false;

  /// `reply` sends a reply the program is owed. The kitty query (CSI ? u) is
  /// left to the VT, which answers it from its own copy of the same state.
  constructor(
    private readonly protocol: TerminalKeyboardProtocolState,
    private readonly reply: (data: string) => void,
  ) {}

  push(bytes: Uint8Array): void {
    for (const byte of bytes) this.step(byte);
  }

  private step(byte: number): void {
    if (byte === CAN || byte === SUB) {
      this.state = "ground";
      return;
    }
    if (byte === ESC) {
      // ESC aborts a CSI and starts a new sequence.
      this.state = "escape";
      return;
    }
    switch (this.state) {
      case "ground":
        return;
      case "escape":
        // C0 controls run inside an escape without ending it; DEL is ignored.
        if (byte < 0x20 || byte === 0x7f) return;
        if (byte === 0x5b) {
          this.enterCsi();
          return;
        }
        if (byte === 0x63) resetTerminalKeyboardProtocolState(this.protocol);
        this.state = "ground";
        return;
      case "csi-entry":
      case "csi-param":
      case "csi-intermediate":
      case "csi-ignore":
        this.stepCsi(byte);
        return;
    }
  }

  private enterCsi(): void {
    this.state = "csi-entry";
    this.prefix = "";
    this.intermediates = "";
    this.params = [0];
    this.subParams = [[]];
    this.digitIsSub = false;
    this.subParamCount = 0;
    this.rejectDigits = false;
    this.rejectSubDigits = false;
  }

  private stepCsi(byte: number): void {
    // C0 controls execute inside a CSI without ending it; DEL is ignored.
    if (byte < 0x20 || byte === 0x7f) return;
    if (byte > 0x7f) {
      this.state = "ground";
      return;
    }
    if (this.state === "csi-ignore") {
      if (byte >= 0x40) this.state = "ground";
      return;
    }
    if (byte >= 0x40) {
      this.dispatch(String.fromCharCode(byte));
      this.state = "ground";
      return;
    }
    if (byte <= 0x2f) {
      this.intermediates += String.fromCharCode(byte);
      this.state = "csi-intermediate";
      return;
    }
    // 0x30-0x3f: params, or a prefix as the first character.
    if (this.state === "csi-intermediate") {
      this.state = "csi-ignore";
      return;
    }
    if (byte >= 0x3c) {
      if (this.state === "csi-entry") {
        this.prefix = String.fromCharCode(byte);
        this.state = "csi-param";
      } else {
        this.state = "csi-ignore";
      }
      return;
    }
    this.state = "csi-param";
    if (byte === 0x3b) this.addParam();
    else if (byte === 0x3a) this.addSubParam();
    else this.addDigit(byte - 0x30);
  }

  private addParam(): void {
    this.digitIsSub = false;
    if (this.params.length >= MAX_PARAMS) {
      this.rejectDigits = true;
      return;
    }
    this.params.push(0);
    this.subParams.push([]);
  }

  private addSubParam(): void {
    this.digitIsSub = true;
    if (this.rejectDigits || this.subParamCount >= MAX_SUB_PARAMS) {
      this.rejectSubDigits = true;
      return;
    }
    this.subParamCount++;
    this.subParams[this.params.length - 1]!.push(-1);
  }

  private addDigit(digit: number): void {
    if (this.rejectDigits || (this.digitIsSub && this.rejectSubDigits)) return;
    const store = this.digitIsSub ? this.subParams[this.params.length - 1]! : this.params;
    const cur = store[store.length - 1]!;
    store[store.length - 1] = cur === -1 ? digit : Math.min(cur * 10 + digit, MAX_VALUE);
  }

  private dispatch(final: string): void {
    const params: CsiParam[] = [];
    this.params.forEach((param, i) => {
      params.push(param);
      if (this.subParams[i]!.length) params.push([...this.subParams[i]!]);
    });
    const reply = applyKeyboardProtocolCsi(this.protocol, {
      prefix: this.prefix,
      intermediates: this.intermediates,
      final,
      params,
    });
    if (reply && !(this.prefix === "?" && final === "u" && !this.intermediates)) {
      this.reply(reply);
    }
  }
}
