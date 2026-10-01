// Date pill format catalog.
//
// One source of truth for the date pill UX: each entry pairs a
// human-readable label, a formatter (Date -> string), and a regex
// used both for live-detection (typing a matching string converts
// to a pill) and for round-trip parsing (the markdown carries the
// formatted string verbatim; on load the regex re-pills it).
//
// Year-bearing only: every catalog entry stores enough to
// round-trip without losing the year. Year-less formats surprised
// users when files written in one year re-pilled as a different
// one on next open, so all catalog entries carry the year.
//
// Adding a new format means: extend `DATE_FORMATS`, add the
// matching `<select>` option (auto-derived), and bump nothing.
// Detection is regex-driven and runs every catalog entry on every
// scan, so old documents keep being auto-pilled.
//
// Ambiguity: pure numeric slash formats can't be told apart from
// the text alone ("04/05/2024" is May 4th in British DMY but April
// 5th in American MDY). `findDateMatches` accepts an optional
// `preferredId`; when both DMY and MDY regexes match the same
// span, the user's preference wins. Day > 12 (DMY) or month > 12
// (MDY) is the natural tiebreaker for the rest.

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_LONG_RE = MONTH_LONG.join("|");
const MONTH_SHORT_RE = MONTH_SHORT.join("|");

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/// English ordinal suffix for a day-of-month (1..31).
function ordinal(d: number): string {
  if (d >= 11 && d <= 13) return `${d}th`;
  switch (d % 10) {
    case 1: return `${d}st`;
    case 2: return `${d}nd`;
    case 3: return `${d}rd`;
    default: return `${d}th`;
  }
}

export type DateFormatId =
  | "iso"
  | "medium"
  | "british-long"
  | "british-ord"
  | "american-long"
  | "dmy-slash"
  | "mdy-slash";

export type DateFormatDef = {
  id: DateFormatId;
  /// Label for the picker dropdown.
  label: string;
  /// Whether the formatted output carries a year. Year-less formats
  /// reattach the current year on parse; the pill displays without
  /// the year regardless.
  hasYear: boolean;
  /// Format a Date as the canonical string for this id.
  format: (d: Date) => string;
  /// Pattern fragment (no anchors, no flags) used to detect
  /// occurrences of this format in arbitrary text. Wrapped at
  /// match time with word boundaries.
  pattern: string;
  /// Parse a string previously produced by `format` (or matched
  /// by `pattern`) back into a Date. Returns null on parse failure.
  parse: (s: string) => Date | null;
};

/// Validate a Date object built via `new Date(y, m, d)` against the
/// numeric components we passed in. JS silently rolls over invalid
/// dates (Feb 30 -> Mar 2), and we don't want pills on impossible
/// inputs.
function ymdValid(d: Date, y: number, m0: number, da: number): boolean {
  return d.getFullYear() === y && d.getMonth() === m0 && d.getDate() === da;
}

const ISO: DateFormatDef = {
  id: "iso",
  label: "2026-05-05 (ISO)",
  hasYear: true,
  format: (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  pattern: "\\d{4}-\\d{2}-\\d{2}",
  parse: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const [, y, mo, da] = m;
    const d = new Date(Number(y), Number(mo) - 1, Number(da));
    return ymdValid(d, Number(y), Number(mo) - 1, Number(da)) ? d : null;
  },
};

const MEDIUM_PARSE_RE = new RegExp(`^(\\d{2}) (${MONTH_SHORT_RE}) (\\d{4})$`);

const MEDIUM: DateFormatDef = {
  id: "medium",
  label: "02 Jan 2029",
  hasYear: true,
  format: (d) => `${pad2(d.getDate())} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`,
  pattern: `\\d{2} (?:${MONTH_SHORT_RE}) \\d{4}`,
  parse: (s) => {
    const m = MEDIUM_PARSE_RE.exec(s);
    if (!m) return null;
    const [, da, mo, y] = m;
    const moIdx = MONTH_SHORT.indexOf(mo);
    if (moIdx < 0) return null;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

const BRITISH_LONG_PARSE_RE = new RegExp(`^(\\d{1,2}) (${MONTH_LONG_RE}) (\\d{4})$`);

/// "13 April 2024" - British long form. Day first, full month name,
/// no comma. `\d{1,2}` to accept both "2 April 2024" and "02 April
/// 2024" since either reads naturally in prose.
const BRITISH_LONG: DateFormatDef = {
  id: "british-long",
  label: "13 April 2024 (British)",
  hasYear: true,
  format: (d) => `${d.getDate()} ${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`,
  pattern: `\\d{1,2} (?:${MONTH_LONG_RE}) \\d{4}`,
  parse: (s) => {
    const m = BRITISH_LONG_PARSE_RE.exec(s);
    if (!m) return null;
    const [, da, mo, y] = m;
    const moIdx = MONTH_LONG.indexOf(mo);
    if (moIdx < 0) return null;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

const BRITISH_ORD_PARSE_RE = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th) (${MONTH_LONG_RE}) (\\d{4})$`);

/// "13th April 2024" - British with ordinal day. The ordinal suffix
/// keeps this distinct from `british-long` so the two coexist; the
/// matcher emits whichever the user actually typed.
const BRITISH_ORD: DateFormatDef = {
  id: "british-ord",
  label: "13th April 2024 (ordinal)",
  hasYear: true,
  format: (d) => `${ordinal(d.getDate())} ${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`,
  pattern: `\\d{1,2}(?:st|nd|rd|th) (?:${MONTH_LONG_RE}) \\d{4}`,
  parse: (s) => {
    const m = BRITISH_ORD_PARSE_RE.exec(s);
    if (!m) return null;
    const [, da, mo, y] = m;
    const moIdx = MONTH_LONG.indexOf(mo);
    if (moIdx < 0) return null;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

const AMERICAN_LONG_PARSE_RE = new RegExp(`^(${MONTH_LONG_RE}) (\\d{1,2}), (\\d{4})$`);

/// "April 13, 2024" - American long form. Month first, comma after
/// the day. `\d{1,2}` to accept "April 5, 2024" as well as the
/// zero-padded variant.
const AMERICAN_LONG: DateFormatDef = {
  id: "american-long",
  label: "April 13, 2024 (American)",
  hasYear: true,
  format: (d) => `${MONTH_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
  pattern: `(?:${MONTH_LONG_RE}) \\d{1,2}, \\d{4}`,
  parse: (s) => {
    const m = AMERICAN_LONG_PARSE_RE.exec(s);
    if (!m) return null;
    const [, mo, da, y] = m;
    const moIdx = MONTH_LONG.indexOf(mo);
    if (moIdx < 0) return null;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

/// "13/04/2024" - British numeric (day-month-year). Shares the same
/// regex shape as MDY but parses with day first; the parser rejects
/// impossible months (>12) so a clearly-DMY string with day > 12
/// still pills correctly even if MDY is the user's preference.
const DMY_SLASH: DateFormatDef = {
  id: "dmy-slash",
  label: "13/04/2024 (DD/MM/YYYY)",
  hasYear: true,
  format: (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`,
  pattern: "\\d{2}/\\d{2}/\\d{4}",
  parse: (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    const [, da, mo, y] = m;
    const moIdx = Number(mo) - 1;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

/// "04/13/2024" - American numeric (month-day-year). Same regex
/// shape as DMY; parser rejects impossible days (>31) and months
/// (>12). For the genuinely ambiguous middle range (both day and
/// month <= 12) the user's preferred format wins; see
/// findDateMatches.
const MDY_SLASH: DateFormatDef = {
  id: "mdy-slash",
  label: "04/13/2024 (MM/DD/YYYY)",
  hasYear: true,
  format: (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`,
  pattern: "\\d{2}/\\d{2}/\\d{4}",
  parse: (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    const [, mo, da, y] = m;
    const moIdx = Number(mo) - 1;
    const d = new Date(Number(y), moIdx, Number(da));
    return ymdValid(d, Number(y), moIdx, Number(da)) ? d : null;
  },
};

export const DATE_FORMATS: readonly DateFormatDef[] = [
  ISO,
  MEDIUM,
  BRITISH_LONG,
  BRITISH_ORD,
  AMERICAN_LONG,
  DMY_SLASH,
  MDY_SLASH,
];

const BY_ID = new Map<DateFormatId, DateFormatDef>(
  DATE_FORMATS.map((f) => [f.id, f]),
);

/// Look up a format by id. Falls back to ISO for unknown ids
/// (which can happen if an older client wrote a format we no
/// longer ship).
export function dateFormat(id: string): DateFormatDef {
  return BY_ID.get(id as DateFormatId) ?? ISO;
}

/// Format a date using the named format.
export function formatDate(d: Date, id: string): string {
  return dateFormat(id).format(d);
}

/// Parse a previously-formatted string back into a Date.
export function parseFormatted(s: string, id: string): Date | null {
  return dateFormat(id).parse(s);
}

/// Convert an ISO YYYY-MM-DD string to a Date (local time, midnight).
/// Returns null if the input doesn't match the ISO shape; this is the
/// canonical attribute-storage format on the date node.
export function dateFromIso(iso: string): Date | null {
  return ISO.parse(iso);
}

/// Format a Date as the canonical ISO YYYY-MM-DD attribute value.
export function isoOf(d: Date): string {
  return ISO.format(d);
}

export type DateMatch = {
  /// 0-indexed character offset of the match start within the
  /// scanned string.
  start: number;
  /// 0-indexed offset just past the match (slice-style).
  end: number;
  /// The matched substring.
  text: string;
  /// Format id whose pattern produced the match.
  formatId: DateFormatId;
  /// Parsed underlying date (year reattached for year-less formats).
  date: Date;
};

/// Sentinel characters for word-boundary detection. We treat any
/// alphanumeric / dash / slash / dot adjacent to a candidate as a
/// "still part of a longer token" signal; otherwise the match
/// stands. Dash keeps "2026-05-05" from bleeding into hyphenated
/// identifiers, slash keeps "/path/04/05/2024.txt" from pilling.
const SENTINEL_BAD = "A-Za-z0-9./\\-";

/// One scan pattern per catalog format, in catalog order, built once. Each
/// is global, and a global RegExp keeps its position between calls, so a
/// scan resets `lastIndex` before it starts.
const SCAN_PATTERNS: readonly RegExp[] = DATE_FORMATS.map(
  (fmt) => new RegExp(`(?:^|[^${SENTINEL_BAD}])(${fmt.pattern})(?=$|[^${SENTINEL_BAD}])`, "g"),
);

/// Find every date occurrence in `text` across every catalog format.
/// Matches are returned in document order. Overlap resolution uses
/// a longest-match-wins rule plus an optional `preferredId` so the
/// user's chosen format wins ambiguous ties (DMY vs MDY slash
/// numerics being the canonical case).
export function findDateMatches(
  text: string,
  preferredId?: string,
): DateMatch[] {
  // Collect every (start, end, format) candidate by scanning each
  // pattern independently. Cheaper than the previous combined-
  // alternation regex when patterns produce overlapping matches,
  // and lets parse-failure of one format fall through to another
  // instead of silently dropping the span.
  type Candidate = {
    start: number;
    end: number;
    text: string;
    formatId: DateFormatId;
    date: Date;
    /// Index in DATE_FORMATS for the secondary sort key.
    rank: number;
  };
  const cands: Candidate[] = [];
  for (let i = 0; i < DATE_FORMATS.length; i++) {
    const fmt = DATE_FORMATS[i]!;
    const re = SCAN_PATTERNS[i]!;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matched = m[1]!;
      const offset = m[0].lastIndexOf(matched);
      const start = m.index + offset;
      const end = start + matched.length;
      const date = fmt.parse(matched);
      // Advance past this match so back-to-back dates separated by
      // a single non-word char both fire (the leading sentinel
      // would otherwise be re-consumed and we'd miss the next one).
      re.lastIndex = end;
      if (!date) continue;
      cands.push({ start, end, text: matched, formatId: fmt.id, date, rank: i });
    }
  }
  // Stable sort: position ascending, then longest first, then
  // preferred-id first, then catalog rank. Stability across equal
  // keys keeps the result deterministic.
  cands.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA;
    if (preferredId) {
      const aPref = a.formatId === preferredId ? 0 : 1;
      const bPref = b.formatId === preferredId ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    return a.rank - b.rank;
  });
  // Greedy take in document order, skipping overlaps.
  const out: DateMatch[] = [];
  let pos = 0;
  for (const c of cands) {
    if (c.start < pos) continue;
    out.push({
      start: c.start,
      end: c.end,
      text: c.text,
      formatId: c.formatId,
      date: c.date,
    });
    pos = c.end;
  }
  return out;
}
