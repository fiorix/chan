/// Osc52Bridge -- a stateful OSC 52 clipboard observer for the PTY ->
/// terminal output path, backing the ghostty-web terminal backend.
///
/// WHY a byte observer: ghostty-web's WASM build compiles Ghostty's own
/// VT engine, and its WASM shim lists the parser's clipboard-contents
/// action under "actions that require no response and have no terminal
/// effect" -- OSC 52 is parsed and then silently dropped, with no
/// registerOscHandler equivalent on the JS side (the xterm path's hook
/// in xtermReports.ts reaches xterm-internal parser state that does not
/// exist here). The only non-fork mechanism is to watch the bytes
/// before they reach write(); the xterm backend keeps its parser hook,
/// the ghostty backend runs this observer.
///
/// Observe-ONLY by design: push() returns nothing and never withholds
/// or rewrites bytes. ghostty's parser already swallows OSC 52, so
/// letting the sequence pass through untouched is harmless -- and means
/// a scanner bug can never corrupt the screen (fail-open, same
/// philosophy as MouseModeFilter).
///
/// Grammar observed: `ESC ] 52 ; Pc ; Pd (BEL | ESC \)`. The full
/// candidate text (`Pc ; Pd`) is handed to handleOsc52Clipboard, so
/// selection-param handling, the never-answered `?` query form, base64
/// decoding, and malformed-payload warnings stay byte-identical to the
/// xterm path -- one source of truth for OSC 52 semantics. C1 ST
/// (0x9c) is NOT treated as a terminator: it collides with UTF-8
/// continuation bytes and no real clipboard program emits it (BEL and
/// ESC \ are the forms in the wild); CAN/SUB and other C0 controls
/// abort the candidate like xterm's parser does.
///
/// Statefulness: a chunk ending mid-candidate holds the partial tail
/// and prepends it to the next push. The hold is capped at MAX_HOLD
/// bytes -- payloads are base64 text, so large copies are permitted --
/// and on overflow the candidate is dropped: the clipboard write is
/// skipped, never the bytes (they already passed through verbatim).

import { handleOsc52Clipboard } from "./xtermReports";

/// Hold cap for a candidate spanning chunk boundaries. 1MB of base64
/// covers ~750KB of copied text; anything larger is pathological and
/// gets its write skipped (fail-open, see module doc).
const MAX_HOLD = 1 << 20;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;

type Osc52Match =
  | { kind: "partial" }
  | { kind: "nomatch" }
  | { kind: "hit"; dataStart: number; dataEnd: number; end: number };

/// Scan a candidate starting at `buf[i] === ESC`. Any byte that breaks
/// the grammar (prefix mismatch, an aborting C0 control, an ESC not
/// starting ST) makes the candidate a nomatch; running out of buffer
/// mid-candidate reports a partial for the caller to hold across the
/// chunk boundary.
function matchOsc52(buf: Uint8Array, i: number): Osc52Match {
  // Prefix: ESC ] 5 2 ;
  const prefix = [0x5d, 0x35, 0x32, 0x3b]; // ']' '5' '2' ';'
  for (let k = 0; k < prefix.length; k++) {
    if (i + 1 + k >= buf.length) return { kind: "partial" };
    if (buf[i + 1 + k] !== prefix[k]) return { kind: "nomatch" };
  }
  const dataStart = i + 1 + prefix.length;
  for (let j = dataStart; j < buf.length; j++) {
    const c = buf[j];
    if (c === BEL) {
      return { kind: "hit", dataStart, dataEnd: j, end: j + 1 };
    }
    if (c === ESC) {
      if (j + 1 >= buf.length) return { kind: "partial" };
      if (buf[j + 1] === BACKSLASH) {
        return { kind: "hit", dataStart, dataEnd: j, end: j + 2 };
      }
      return { kind: "nomatch" }; // ESC aborts the OSC without completing ST
    }
    if (c < 0x20) return { kind: "nomatch" }; // CAN/SUB/other C0: aborted
  }
  return { kind: "partial" };
}

export class Osc52Bridge {
  #held: Uint8Array = new Uint8Array(0);

  /// Drop any held partial candidate. Call on session teardown; never
  /// mid-stream (the held bytes' continuation is still in flight).
  reset(): void {
    this.#held = new Uint8Array(0);
  }

  /// Observe one PTY output chunk. Bytes are never returned, withheld,
  /// or rewritten -- the terminal receives them untouched regardless of
  /// what the scanner concludes.
  push(bytes: Uint8Array): void {
    let buf: Uint8Array;
    if (this.#held.length) {
      buf = new Uint8Array(this.#held.length + bytes.length);
      buf.set(this.#held);
      buf.set(bytes, this.#held.length);
      this.#held = new Uint8Array(0);
    } else {
      // Fast path: no held state and no ESC anywhere -- the chunk
      // cannot contain or start a candidate.
      if (bytes.indexOf(ESC) === -1) return;
      buf = bytes;
    }
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== ESC) {
        i++;
        continue;
      }
      const m = matchOsc52(buf, i);
      if (m.kind === "nomatch") {
        i++;
        continue;
      }
      if (m.kind === "partial") {
        if (buf.length - i > MAX_HOLD) {
          // Over-cap candidate: drop it (write skipped, bytes already
          // passed through) and keep scanning after the ESC.
          i++;
        } else {
          this.#held = buf.slice(i);
          i = buf.length;
        }
        continue;
      }
      // Candidate bytes are ASCII by grammar (C0s abort; UTF-8 high
      // bytes ride along leniently and make atob throw downstream,
      // exactly like the xterm path's handler).
      let data = "";
      for (let k = m.dataStart; k < m.dataEnd; k++) {
        data += String.fromCharCode(buf[k]);
      }
      handleOsc52Clipboard(data);
      i = m.end;
    }
  }
}
