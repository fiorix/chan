import type { IBufferLine, IDecoration, IMarker, Terminal } from "@xterm/xterm";

// Mirrored in crates/chan-library/src/config.rs
// (DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES), which is authoritative for
// current servers; this copy is the SPA fallback for servers that predate
// the field. Keep in lockstep.
export const DEFAULT_SECRET_MASK_SUFFIXES = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSPHRASE",
  "API_KEY",
  "ACCESS_KEY",
  "SECRET_KEY",
  "PRIVATE_KEY",
  "SSH_KEY",
  "SIGNING_KEY",
  "KEY_BASE64",
  "CREDENTIALS",
] as const;

const SECRET_MASK_SUFFIX_MAX = 100;
const LITERAL_SUFFIX = /^[A-Za-z0-9_]+$/;

export type SecretValueRange = {
  start: number;
  end: number;
};

export type SecretMaskSpan = {
  row: number;
  x: number;
  width: number;
};

type GroupLine = {
  row: number;
  line: IBufferLine;
};

type TextCell = SecretMaskSpan & {
  start: number;
  end: number;
};

const NAME_RUN = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/// End of the value starting at `start` (the char after `=`), or -1 when
/// there is no value to mask. A quoted value runs to its closing quote, or
/// to end of text when unterminated; a CR/LF before the closing quote means
/// the quote was not a value opener, so the assignment masks nothing. An
/// unquoted value runs to the next whitespace. Quote-aware parsing lives in
/// code, not in a regex: a backtracking alternation over the name and value
/// shapes goes quadratic on a long run of word characters, and the scan is
/// on the live PTY path.
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === undefined) return -1;
  if (first === '"' || first === "'") {
    for (let i = start + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === first) return i + 1;
      if (ch === "\r" || ch === "\n") return -1;
    }
    return text.length;
  }
  if (WHITESPACE.test(first)) return -1;
  let end = start + 1;
  while (end < text.length && !WHITESPACE.test(text[end])) end += 1;
  return end;
}

export class SecretAssignmentMatcher {
  readonly #suffixes: readonly string[];

  constructor(suffixes: readonly string[]) {
    this.#suffixes = Array.from(
      new Set(
        suffixes
          .slice(0, SECRET_MASK_SUFFIX_MAX)
          .filter((suffix) => LITERAL_SUFFIX.test(suffix))
          .map((suffix) => suffix.toUpperCase()),
      ),
    );
  }

  find(text: string): SecretValueRange[] {
    if (this.#suffixes.length === 0) return [];
    const ranges: SecretValueRange[] = [];
    NAME_RUN.lastIndex = 0;
    for (let match = NAME_RUN.exec(text); match; match = NAME_RUN.exec(text)) {
      // A word character immediately before the candidate means the name is
      // digit-led or mid-word, neither of which is an assignment name.
      const previous = text[match.index - 1];
      if (previous && WORD_CHAR.test(previous)) continue;
      const name = match[0].toUpperCase();
      if (!this.#suffixes.some((suffix) => name.endsWith(suffix))) continue;
      const eq = match.index + match[0].length;
      if (text[eq] !== "=") continue;
      const end = valueEnd(text, eq + 1);
      if (end < 0) continue;
      ranges.push({ start: eq + 1, end });
      // An accepted assignment owns its value, so the scan resumes past it
      // and names inside it stay value text. A rejected candidate owns
      // nothing and the name-run scan simply moves on, so secret-looking
      // text inside e.g. a digit-led `1TOKEN="..."` still masks.
      NAME_RUN.lastIndex = end;
    }
    return ranges;
  }
}

function translatedLine(line: IBufferLine, cols: number): string {
  return line.translateToString(false, 0, cols);
}

function lineTextCells(line: GroupLine, cols: number, textOffset: number): TextCell[] {
  const cells: TextCell[] = [];
  let offset = textOffset;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    cells.push({
      row: line.row,
      x,
      width,
      start: offset,
      end: offset + chars.length,
    });
    offset += chars.length;
  }
  return cells;
}

/// Convert matcher string offsets back to xterm cell spans. The matcher sees
/// joined post-parse buffer rows; this mapping preserves wide and combined
/// cells while splitting one wrapped value into one decoration per row.
export function findSecretMaskSpans(
  lines: readonly GroupLine[],
  cols: number,
  matcher: SecretAssignmentMatcher,
): SecretMaskSpan[] {
  let text = "";
  const cells: TextCell[] = [];
  for (const line of lines) {
    const translated = translatedLine(line.line, cols);
    cells.push(...lineTextCells(line, cols, text.length));
    text += translated;
  }

  const spans: SecretMaskSpan[] = [];
  for (const range of matcher.find(text)) {
    for (const cell of cells) {
      if (cell.end <= range.start || cell.start >= range.end) continue;
      const previous = spans.at(-1);
      if (
        previous &&
        previous.row === cell.row &&
        previous.x + previous.width === cell.x
      ) {
        previous.width += cell.width;
      } else {
        spans.push({ row: cell.row, x: cell.x, width: cell.width });
      }
    }
  }
  return spans;
}

export type SecretMaskWriteSnapshot = {
  bufferType: "normal" | "alternate";
  startRow: number;
  markerLine: number;
  marker: IMarker | null;
  rows: Map<number, string>;
};

type DecorationEntry = {
  decoration: IDecoration;
  marker: IMarker;
};

/// Owns the visual-only xterm decorations for one terminal tab. Every scan
/// reads translated buffer lines and only decorations are changed; PTY bytes,
/// buffer cells, selection, copy, replay, and serialization remain untouched.
export class TerminalSecretMasker {
  readonly #term: Terminal;
  readonly #matcher: SecretAssignmentMatcher;
  readonly #decorations = new Set<DecorationEntry>();
  readonly #onError: (() => void) | null;
  #enabled: boolean;
  #color: string;
  #disposed = false;

  constructor(
    term: Terminal,
    suffixes: readonly string[],
    color: string,
    enabled: boolean,
    onError?: () => void,
  ) {
    this.#term = term;
    this.#matcher = new SecretAssignmentMatcher(suffixes);
    this.#color = color;
    this.#enabled = enabled;
    this.#onError = onError ?? null;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get maskCount(): number {
    return this.#decorations.size;
  }

  setEnabled(enabled: boolean): void {
    if (this.#disposed || enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) this.scanAll();
    else this.clear();
  }

  setColor(color: string): void {
    if (this.#disposed || color === this.#color) return;
    this.#color = color;
    if (this.#enabled) this.scanAll();
  }

  captureWrite(): SecretMaskWriteSnapshot | null {
    try {
      const buffer = this.#activeBuffer();
      if (this.#disposed || !this.#enabled || !buffer) {
        return null;
      }
      const startRow = buffer.baseY;
      const rows = new Map<number, string>();
      for (let row = startRow; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (line) rows.set(row, this.#lineSignature(line));
      }
      const markerLine = buffer.baseY + buffer.cursorY;
      const marker = this.#term.registerMarker();
      return { bufferType: buffer.type, startRow, markerLine, marker, rows };
    } catch (error) {
      this.#fail("xterm secret masking snapshot failed", error);
      return null;
    }
  }

  scanWrite(snapshot: SecretMaskWriteSnapshot | null): void {
    if (!snapshot) return;
    try {
      const buffer = this.#activeBuffer();
      if (this.#disposed || !this.#enabled || !buffer) {
        return;
      }
      if (buffer.type !== snapshot.bufferType) {
        // Buffer switches replace the visible coordinate space. Rebuild from
        // the now-active buffer so a write that enters or leaves a TUI cannot
        // inherit stale markers or skip output parsed after the switch.
        this.scanAll();
        return;
      }
      const marker = snapshot.marker;
      if (!marker || marker.isDisposed) {
        // Without a live marker the trim amount cannot be measured (a huge
        // batch can scroll the captured cursor line itself out of the
        // buffer), so the snapshot's row keys cannot be re-based. Rebuild
        // from the current buffer.
        this.scanAll();
        return;
      }
      // A trim while parsing the batch shifts absolute row indices up by the
      // trim count. The marker was registered on the pre-write cursor line
      // and tracks that shift, so its drift re-bases the snapshot's row keys
      // onto post-write indices: a row whose content only moved compares
      // equal and keeps its decoration (decoration markers shift with their
      // content), and only genuinely changed or newly appended rows rescan.
      // Decorations on rows the trim scrolled away are disposed by xterm
      // with their markers.
      const shift = snapshot.markerLine - marker.line;
      const startRow = Math.max(0, snapshot.startRow - shift);
      const dirtyRows: number[] = [];
      for (let row = startRow; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (!line) continue;
        if (snapshot.rows.get(row + shift) !== this.#lineSignature(line)) {
          dirtyRows.push(row);
        }
      }
      this.#scanDirtyRows(dirtyRows);
    } catch (error) {
      this.#fail("xterm secret masking scan failed", error);
    } finally {
      snapshot.marker?.dispose();
    }
  }

  scanAll(): void {
    if (this.#disposed || !this.#enabled) return;
    try {
      const buffer = this.#activeBuffer();
      if (!buffer) return;
      this.clear();
      const rows = Array.from({ length: buffer.length }, (_, row) => row);
      this.#scanDirtyRows(rows);
    } catch (error) {
      this.#fail("xterm secret masking scan failed", error);
    }
  }

  clear(): void {
    for (const entry of Array.from(this.#decorations)) {
      this.#disposeEntry(entry);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  #activeBuffer(): Terminal["buffer"]["active"] | null {
    return (
      (this.#term.buffer as Terminal["buffer"] | undefined)?.active ?? null
    );
  }

  #lineSignature(line: IBufferLine): string {
    return `${line.isWrapped ? "1" : "0"}\0${translatedLine(line, this.#term.cols)}`;
  }

  #scanDirtyRows(dirtyRows: readonly number[]): void {
    const buffer = this.#activeBuffer();
    if (!buffer || dirtyRows.length === 0) return;
    const groupStarts = new Set<number>();
    for (const dirtyRow of dirtyRows) {
      if (!buffer.getLine(dirtyRow)) continue;
      let start = dirtyRow;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
      groupStarts.add(start);
    }
    for (const start of Array.from(groupStarts).sort((a, b) => a - b)) {
      let end = start;
      while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) {
        end += 1;
      }
      this.#scanGroup(start, end);
    }
  }

  #scanGroup(start: number, end: number): void {
    const buffer = this.#activeBuffer();
    if (!buffer) return;
    for (const entry of Array.from(this.#decorations)) {
      const row = entry.marker.line;
      if (row < 0 || (row >= start && row <= end)) this.#disposeEntry(entry);
    }

    const lines: GroupLine[] = [];
    for (let row = start; row <= end; row += 1) {
      const line = buffer.getLine(row);
      if (line) lines.push({ row, line });
    }
    for (const span of findSecretMaskSpans(lines, this.#term.cols, this.#matcher)) {
      this.#registerSpan(span);
    }
  }

  #registerSpan(span: SecretMaskSpan): void {
    const buffer = this.#activeBuffer();
    if (!buffer || span.width <= 0 || !this.#enabled) return;
    const marker = this.#term.registerMarker(
      span.row - (buffer.baseY + buffer.cursorY),
    );
    const decoration = this.#term.registerDecoration({
      marker,
      x: span.x,
      width: span.width,
      height: 1,
      backgroundColor: this.#color,
      foregroundColor: this.#color,
      layer: "top",
    });
    if (!decoration) {
      marker.dispose();
      this.#fail("xterm secret masking decoration registration failed");
      return;
    }
    const entry = { decoration, marker };
    this.#decorations.add(entry);
    decoration.onDispose(() => {
      this.#decorations.delete(entry);
      if (!marker.isDisposed) marker.dispose();
    });
    decoration.onRender((element) => {
      element.classList.add("terminal-secret-mask");
      // The cell fg/bg recolor is the primary mask; paint the decoration
      // element itself too, or a renderer that drops decoration cell colors
      // would show the value through a styled but transparent chip.
      element.style.backgroundColor = this.#color;
    });
  }

  /// Masking that stops silently is the worst failure mode for a visual
  /// feature, whether the cause is a decoration that cannot register or an
  /// exception thrown out of a scan. Fail loud to the user, not just the
  /// console: drop every decoration, switch the masker off, and notify so
  /// the UI can surface a visible status. Re-enabling (the per-tab toggle)
  /// retries from a clean scan.
  #fail(message: string, error?: unknown): void {
    console.error(message, error ?? "");
    this.clear();
    this.#enabled = false;
    this.#onError?.();
  }

  #disposeEntry(entry: DecorationEntry): void {
    this.#decorations.delete(entry);
    if (!entry.decoration.isDisposed) entry.decoration.dispose();
    if (!entry.marker.isDisposed) entry.marker.dispose();
  }
}
