import { DEVSERVER_TOKEN_MARKER } from "./snapshotCache";

/// The cell a painter's buffer line hands back: what the span mapping
/// reads of it. Both xterm.js's IBufferCell and ghostty-web's satisfy it.
export type MaskCell = {
  getWidth(): number;
  getChars(): string;
};

/// A buffer line as the detection reads it: the text of a column range,
/// the cell at a column and whether the line continues the one above it.
/// xterm.js's IBufferLine and ghostty-web's both satisfy it, so the two
/// painters share one detection over their own buffers.
export type MaskLine = {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell(x: number): MaskCell | undefined;
};

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

/// One row of a wrapped group, by its absolute buffer row.
export type MaskGroupLine = {
  row: number;
  line: MaskLine;
};

type TextCell = SecretMaskSpan & {
  start: number;
  end: number;
};

const NAME_RUN = /[A-Za-z_][A-Za-z0-9_]*/g;
const WORD_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

// The name chan prints a devserver's bearer token under, on the line below
// the launch URL that carries the same token: the marker without its `=`.
const DEVSERVER_TOKEN_NAME = DEVSERVER_TOKEN_MARKER.slice(0, -1).toUpperCase();
// The start of an http or https URL whose host is a loopback one, or the
// unspecified address a server bound to every interface prints as its own.
// What may follow the host is checked in code.
const LOOPBACK_URL_START = /https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1?\])/gi;
const URL_END = /[\s"'<>]/;
const DIGIT = /[0-9]/;

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

/// The values of the `t` parameters of the loopback URLs in `text`, which is
/// how chan prints a launch URL with its bearer token. The host ends at its
/// port or at the path, query or fragment, so a name that only begins like a
/// loopback one (`localhost.example.com`) is another host. A URL runs to the
/// first whitespace, quote or angle bracket, and its query from its first `?`
/// to its first `#`; a parameter named exactly `t`, as the server reads it,
/// with a value, is masked to the parameter's end. Each URL is walked once
/// and the scan resumes past it, so the pass is linear like the name scan.
function launchUrlTokens(text: string): SecretValueRange[] {
  const ranges: SecretValueRange[] = [];
  LOOPBACK_URL_START.lastIndex = 0;
  for (let match = LOOPBACK_URL_START.exec(text); match; match = LOOPBACK_URL_START.exec(text)) {
    let at = match.index + match[0].length;
    if (text[at] === ":") {
      const port = at + 1;
      at = port;
      while (at < text.length && DIGIT.test(text[at])) at += 1;
      if (at === port) continue;
    }
    if (text[at] !== "/" && text[at] !== "?" && text[at] !== "#") continue;
    let end = at;
    let query = -1;
    let queryEnd = -1;
    for (; end < text.length && !URL_END.test(text[end]); end += 1) {
      if (queryEnd >= 0) continue;
      if (text[end] === "#") queryEnd = end;
      else if (text[end] === "?" && query < 0) query = end;
    }
    LOOPBACK_URL_START.lastIndex = end;
    if (query < 0) continue;
    if (queryEnd < 0) queryEnd = end;
    for (let param = query + 1; param < queryEnd; ) {
      let paramEnd = param;
      while (paramEnd < queryEnd && text[paramEnd] !== "&") paramEnd += 1;
      if (text[param] === "t" && text[param + 1] === "=" && param + 2 < paramEnd) {
        ranges.push({ start: param + 2, end: paramEnd });
      }
      param = paramEnd + 1;
    }
  }
  return ranges;
}

/// Two lists of ranges, each in text order with no overlap of its own, as one
/// such list: ranges that overlap become one, so no cell is masked twice.
function mergeRanges(a: readonly SecretValueRange[], b: readonly SecretValueRange[]): SecretValueRange[] {
  const merged: SecretValueRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i].start <= b[j].start) ? a[i++] : b[j++];
    const last = merged.at(-1);
    if (last && next.start < last.end) last.end = Math.max(last.end, next.end);
    else merged.push({ ...next });
  }
  return merged;
}

/// Finds what a terminal with masking on hides: the value of a `NAME=value`
/// whose name ends in a listed suffix and, while the list masks the name the
/// devserver's token is printed under, the token of a launch URL, so the two
/// copies of that token are masked together or not at all.
export class SecretAssignmentMatcher {
  readonly #suffixes: readonly string[];
  readonly #masksLaunchUrls: boolean;

  constructor(suffixes: readonly string[]) {
    this.#suffixes = Array.from(
      new Set(
        suffixes
          .slice(0, SECRET_MASK_SUFFIX_MAX)
          .filter((suffix) => LITERAL_SUFFIX.test(suffix))
          .map((suffix) => suffix.toUpperCase()),
      ),
    );
    this.#masksLaunchUrls = this.#suffixes.some((suffix) => DEVSERVER_TOKEN_NAME.endsWith(suffix));
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
    return this.#masksLaunchUrls ? mergeRanges(ranges, launchUrlTokens(text)) : ranges;
  }
}

export function translatedLine(line: MaskLine, cols: number): string {
  return line.translateToString(false, 0, cols);
}

function lineTextCells(line: MaskGroupLine, cols: number, textOffset: number): TextCell[] {
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

/// Convert matcher string offsets back to cell spans. The matcher sees
/// joined post-parse buffer rows; this mapping preserves wide and combined
/// cells while splitting one wrapped value into one span per row.
export function findSecretMaskSpans(
  lines: readonly MaskGroupLine[],
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
