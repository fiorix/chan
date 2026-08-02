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

export class SecretAssignmentMatcher {
  readonly #pattern: RegExp | null;

  constructor(suffixes: readonly string[]) {
    const literals = Array.from(
      new Set(
        suffixes
          .slice(0, SECRET_MASK_SUFFIX_MAX)
          .filter((suffix) => LITERAL_SUFFIX.test(suffix))
          .map((suffix) => suffix.toUpperCase()),
      ),
    ).sort((left, right) => right.length - left.length);
    if (literals.length === 0) {
      this.#pattern = null;
      return;
    }

    // The suffixes have already passed the literal-only gate. Keeping them as
    // one alternation means config changes compile once per terminal start,
    // never once per line or PTY write.
    const suffix = `(?:${literals.join("|")})`;
    const name = `(?:${suffix}|[A-Za-z_][A-Za-z0-9_]*${suffix})`;
    const value = `(?:"[^"\\r\\n]*(?:"|$)|'[^'\\r\\n]*(?:'|$)|[^\\s'"][^\\s]*)`;
    this.#pattern = new RegExp(`(${name})=(${value})`, "gi");
  }

  find(text: string): SecretValueRange[] {
    if (!this.#pattern) return [];
    this.#pattern.lastIndex = 0;
    const ranges: SecretValueRange[] = [];
    for (let match = this.#pattern.exec(text); match; match = this.#pattern.exec(text)) {
      const previous = text[match.index - 1];
      if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
      const name = match[1] ?? "";
      const value = match[2] ?? "";
      const start = match.index + name.length + 1;
      ranges.push({ start, end: start + value.length });
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

      // A marker moving backwards means scrollback hit its cap and xterm
      // trimmed rows while parsing this batch. Absolute indices then changed,
      // so the whole surviving buffer is dirty. In the common case only the
      // prior active screen plus newly appended rows are compared.
      const trimmed =
        snapshot.marker?.isDisposed === true ||
        (snapshot.marker !== null && snapshot.marker.line < snapshot.markerLine);
      const startRow = trimmed ? 0 : Math.min(snapshot.startRow, buffer.baseY);
      const dirtyRows: number[] = [];
      for (let row = startRow; row < buffer.length; row += 1) {
        const line = buffer.getLine(row);
        if (!line) continue;
        if (trimmed || snapshot.rows.get(row) !== this.#lineSignature(line)) {
          dirtyRows.push(row);
        }
      }
      this.#scanDirtyRows(dirtyRows);
    } finally {
      snapshot.marker?.dispose();
    }
  }

  scanAll(): void {
    if (this.#disposed || !this.#enabled) return;
    const buffer = this.#activeBuffer();
    if (!buffer) return;
    this.clear();
    const rows = Array.from({ length: buffer.length }, (_, row) => row);
    this.#scanDirtyRows(rows);
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
    });
  }

  /// A decoration that cannot register means masking has silently stopped,
  /// the worst failure mode for a visual feature. Fail loud to the user,
  /// not just the console: drop every decoration, switch the masker off,
  /// and notify so the UI can surface a visible status. Re-enabling (the
  /// per-tab toggle) retries from a clean scan.
  #fail(message: string): void {
    console.error(message);
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
