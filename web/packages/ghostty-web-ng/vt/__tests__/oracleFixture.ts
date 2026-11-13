// The recorded oracle of the binding's differential tests
// (`differential-oracle.json` beside this file): what ghostty-web's own
// binding over its own build read back for a corpus of byte streams, its
// replies, modes and key encodings, written down in a form neither side
// uses internally, so a reader can check a case by eye.
//
// A row is its text and the columns where that text is not the whole story:
// - `text`: one character a cell, a space for a cell nothing was written to,
//   and nothing for a spacer nothing was written to (the column after a wide
//   character, or the last column a wide character did not fit in), up to
//   the last cell something was written to;
// - `empty`: the column ranges, both ends included, of cells nothing was
//   written to (codepoint 0), so a written space and an empty cell differ;
// - `wide` and `spacer`: the columns of cells two columns wide and of
//   spacers;
// - `styles`: runs of columns with one foreground, background (#rrggbb,
//   resolved against the palette and the default colours) and attribute set;
// - `links` and `graphemes`: runs of a hyperlink id other than 0, and the
//   cells holding more than one codepoint with their whole cluster;
// - `wrapped`: a screen row that continues on the next.
// Fields with nothing to say are left out. The text, the empty ranges and
// the width columns together name every cell's codepoint and width, so two
// rows describe alike exactly when their cells are alike.

export const ORACLE_FIXTURE = "vt/__tests__/differential-oracle.json";

/// The attributes a cell can carry, in the order a row lists them.
export const ATTRS = ["bold", "italic", "faint", "blink", "inverse", "invisible", "strikethrough", "underline", "overline"] as const;
export type Attr = (typeof ATTRS)[number];

/// One cell, as either binding's reader is converted to it.
export type FixtureCell = {
  codepoint: number;
  width: number;
  fg: number;
  bg: number;
  attrs: Attr[];
  link: number;
  grapheme: string | null;
};

export type FixtureStyle = { cols: [number, number]; fg: string; bg: string; attrs?: Attr[] };

export type FixtureRow = {
  text: string;
  empty?: [number, number][];
  wide?: number[];
  spacer?: number[];
  styles: FixtureStyle[];
  links?: { cols: [number, number]; id: number }[];
  graphemes?: { col: number; text: string }[];
  wrapped?: boolean;
};

export type FixtureScreen = {
  input: string;
  size: [cols: number, rows: number];
  scrollbackLimit: number;
  cursor: { x: number; y: number; visible: boolean };
  alternateScreen: boolean;
  rows: FixtureRow[];
  history: FixtureRow[];
};

export type FixtureKeyEvent = { key: string; mods?: number; utf8?: string };

export type OracleFixture = {
  recorded: { commit: string; command: string; oracle: string; wasm: string; wasmSha256: string };
  format: string;
  screens: Record<string, FixtureScreen>;
  modes: { set: string; before: Record<string, boolean>; after: Record<string, boolean> };
  replies: { query: string; reply: string | null }[];
  colorQueries: { query: string; reply: string | null }[];
  keys: { event: FixtureKeyEvent; bytes: string }[];
  cursorKeyApplication: { event: FixtureKeyEvent; bytes: string };
  keyOptions: Record<string, { event: FixtureKeyEvent; given?: string; before: string; after: string }>;
};

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

/// Column runs `[first, last]` of the columns `pick` holds for.
function runs(n: number, pick: (x: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < n; x++) {
    if (!pick(x)) continue;
    const last = out.at(-1);
    if (last && last[1] === x - 1) last[1] = x;
    else out.push([x, x]);
  }
  return out;
}

/// A row as the fixture describes it.
export function fixtureRow(cells: FixtureCell[], wrapped?: boolean): FixtureRow {
  const n = cells.length;
  let end = n;
  while (end > 0 && cells[end - 1].codepoint === 0) end--;
  let text = "";
  for (const cell of cells.slice(0, end)) {
    if (cell.width === 0 && cell.codepoint === 0) continue;
    text += cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
  }
  const row: FixtureRow = { text, styles: [] };
  const empty = runs(n, (x) => cells[x].codepoint === 0);
  if (empty.length) row.empty = empty;
  const wide = cells.flatMap((c, x) => (c.width === 2 ? [x] : []));
  if (wide.length) row.wide = wide;
  const spacer = cells.flatMap((c, x) => (c.width === 0 ? [x] : []));
  if (spacer.length) row.spacer = spacer;
  const style = (c: FixtureCell) => `${c.fg} ${c.bg} ${c.attrs.join(",")}`;
  for (let x = 0; x < n; x++) {
    const last = row.styles.at(-1);
    if (last && style(cells[x - 1]) === style(cells[x])) {
      last.cols[1] = x;
      continue;
    }
    const c = cells[x];
    row.styles.push({ cols: [x, x], fg: hex(c.fg), bg: hex(c.bg), ...(c.attrs.length ? { attrs: [...c.attrs] } : {}) });
  }
  const links: { cols: [number, number]; id: number }[] = [];
  for (let x = 0; x < n; x++) {
    const id = cells[x].link;
    if (!id) continue;
    const last = links.at(-1);
    if (last && last.id === id && last.cols[1] === x - 1) last.cols[1] = x;
    else links.push({ cols: [x, x], id });
  }
  if (links.length) row.links = links;
  const graphemes = cells.flatMap((c, x) => (c.grapheme === null ? [] : [{ col: x, text: c.grapheme }]));
  if (graphemes.length) row.graphemes = graphemes;
  if (wrapped) row.wrapped = true;
  return row;
}

/// Encoded key bytes as the text they spell; every encoding in the corpus
/// is UTF-8, which a fatal decoder holds it to.
export function keyText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
