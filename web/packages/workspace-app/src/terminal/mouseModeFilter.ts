/// MouseModeFilter -- a stateful DECSET-mouse-enable strip filter for the
/// PTY -> xterm output path, backing `terminal.mouse_capture = false`.
///
/// WHY a byte filter: xterm.js exposes no public API to refuse mouse
/// reporting -- `Terminal.modes` is a read-only getter and
/// `ITerminalOptions` has no mouse switch. The moment a mouse DECSET is
/// parsed, xterm disables its SelectionService, so click-drag selection
/// dies at the mode flip REGARDLESS of what happens to the outgoing report
/// bytes: intercepting pointer events or dropping outgoing reports provably
/// leaves selection broken. The only non-fork mechanism is to keep xterm
/// from ever seeing the enable sequence. The public
/// `parser.registerCsiHandler` hook is no substitute either: its callback
/// receives a COPY of the params, so a mixed list like `CSI ? 1049;1000 h`
/// can only be swallowed whole (losing the alt-screen switch) or kept
/// whole -- it cannot be rewritten. Hence this pre-parse byte filter.
///
/// Grammar filtered: `ESC [ ? Pm h` (DECSET) ONLY. Params in
/// MOUSE_MODE_PARAMS are dropped; survivors re-emit with their ORIGINAL
/// param text (leading zeros and oversized digit runs stay byte-identical
/// -- never re-serialized from parsed numbers); when every param is a
/// mouse param the whole sequence is dropped. DECRST (`l` final),
/// intermediates (e.g. DECRQM `$p`), colon sub-params, and CSI without the
/// `?` prefix (e.g. SM `CSI 4 h`) all pass through verbatim.
///
/// Statefulness: a chunk ending inside a candidate (`ESC`, `ESC [`,
/// `ESC [ ? 12;10`) holds the partial tail and prepends it to the next
/// push. The hold is capped at MAX_HOLD bytes; on overflow the bytes flush
/// VERBATIM -- fail-OPEN by design: the worst case is mouse mode enabling
/// (today's default behavior), never corrupted output. A pathological
/// over-cap param list split across chunks can therefore still enable
/// mouse mode; deliberate and accepted.

/// DEC private modes that enable mouse tracking/encoding in xterm.js v6:
/// 9 (X10), 1000 (VT200), 1002 (drag), 1003 (any-motion), 1006 (SGR),
/// 1016 (SGR-pixels). 1001/1005/1015 are no-ops or unhandled in xterm v6
/// but are stripped anyway: harmless, future-proof, and they only ever
/// travel alongside the real enables.
export const MOUSE_MODE_PARAMS: ReadonlySet<number> = new Set([
  9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016,
]);

/// Hold cap for a partial candidate spanning a chunk boundary. A real
/// DECSET param list never approaches this; on overflow the held bytes
/// flush verbatim (fail-open, see module doc).
const MAX_HOLD = 256;

type DecsetParam = {
  /// Parsed value used only for the strip-set membership test. Oversized
  /// digit runs (> 5 digits) can never be a mouse param and parse to a -1
  /// sentinel so numeric overflow can never corrupt re-emission.
  value: number;
  /// The param's original byte text; re-emission joins these verbatim.
  text: string;
};

type DecsetMatch =
  | { kind: "partial" }
  | { kind: "nomatch" }
  | { kind: "hit"; params: DecsetParam[]; end: number };

/// Scan a `CSI ? Pm h` candidate starting at `buf[i] === ESC`. Any byte
/// that breaks the grammar (final `l`, intermediates like `$`, colon
/// sub-params, empty `ESC [ ? h`) makes the whole candidate pass verbatim;
/// running out of buffer mid-candidate reports a partial for the caller to
/// hold across the chunk boundary.
function matchDecsetH(buf: Uint8Array, i: number): DecsetMatch {
  if (i + 1 >= buf.length) return { kind: "partial" };
  if (buf[i + 1] !== 0x5b) return { kind: "nomatch" }; // '['
  if (i + 2 >= buf.length) return { kind: "partial" };
  if (buf[i + 2] !== 0x3f) return { kind: "nomatch" }; // '?'
  let j = i + 3;
  const params: DecsetParam[] = [];
  let start = j;
  let sawAny = false;
  const flushParam = (): void => {
    let text = "";
    for (let k = start; k < j; k++) text += String.fromCharCode(buf[k]);
    const value = text.length === 0 ? 0 : text.length > 5 ? -1 : parseInt(text, 10);
    params.push({ value, text });
  };
  while (j < buf.length) {
    const c = buf[j];
    if (c >= 0x30 && c <= 0x39) {
      // digit
      sawAny = true;
      j++;
      continue;
    }
    if (c === 0x3b) {
      // ';'
      flushParam();
      start = j + 1;
      j++;
      continue;
    }
    if (c === 0x68) {
      // 'h' final
      if (!sawAny && params.length === 0) return { kind: "nomatch" }; // CSI ? h
      flushParam();
      return { kind: "hit", params, end: j + 1 };
    }
    return { kind: "nomatch" }; // 'l', '$', ':', anything else: verbatim
  }
  return { kind: "partial" };
}

export class MouseModeFilter {
  #held: Uint8Array = new Uint8Array(0);

  /// Drop any held partial tail. Call on session teardown; never mid-stream
  /// (the held bytes' continuation is still in flight).
  reset(): void {
    this.#held = new Uint8Array(0);
  }

  /// Filter one PTY output chunk. Returns the bytes to hand to xterm; may
  /// be shorter than the input (stripped enables, held tail) and may
  /// include bytes held from previous pushes.
  push(bytes: Uint8Array): Uint8Array {
    let buf: Uint8Array;
    if (this.#held.length) {
      buf = new Uint8Array(this.#held.length + bytes.length);
      buf.set(this.#held);
      buf.set(bytes, this.#held.length);
      this.#held = new Uint8Array(0);
    } else {
      // Fast path: no held state and no ESC anywhere -- the chunk cannot
      // contain or start a candidate, pass it through untouched.
      if (bytes.indexOf(0x1b) === -1) return bytes;
      buf = bytes;
    }
    const out: number[] = [];
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b !== 0x1b) {
        out.push(b);
        i++;
        continue;
      }
      const m = matchDecsetH(buf, i);
      if (m.kind === "nomatch") {
        out.push(b);
        i++;
        continue;
      }
      if (m.kind === "partial") {
        if (buf.length - i > MAX_HOLD) {
          // Over-cap partial: flush verbatim (fail-open, see module doc).
          for (let j = i; j < buf.length; j++) out.push(buf[j]);
        } else {
          this.#held = buf.slice(i);
        }
        i = buf.length;
        break;
      }
      const kept = m.params.filter((p) => !MOUSE_MODE_PARAMS.has(p.value));
      if (kept.length) {
        const rewritten = "\x1b[?" + kept.map((p) => p.text).join(";") + "h";
        for (let k = 0; k < rewritten.length; k++) out.push(rewritten.charCodeAt(k));
      }
      i = m.end;
    }
    return Uint8Array.from(out);
  }
}
