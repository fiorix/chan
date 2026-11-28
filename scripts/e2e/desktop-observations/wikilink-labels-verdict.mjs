// The fixture and the verdict of wikilink-labels.mjs, apart from the
// desktop so wikilink-labels-verdict.test.mjs can read them against made
// observations.
//
// An observation is what the driver read, in the order it read it; a field
// the driver never reached is absent, and a line over an absent field is
// unread. The judge returns its lines in that order: a precondition (`need`)
// says whether the run could put its question, a property (`prop`) is the
// answer. A property that failed before any precondition failed is an
// observed fault; a precondition that failed first leaves the run
// inconclusive, whatever was read after it; an unread line or an instrument
// error leaves it inconclusive too.

export const NOTE = "note.md";
export const NOTE_TEXT = "# Note\n";
export const TABLE = "table.md";
/// The line above the table. The driver finds the fixture's editor by it,
/// and it keeps a fresh open's caret, at the document's start, out of the
/// table, whose widget is drawn only while the caret is outside it.
export const MARKER = "wikilabels before the table";
export const HEADERS = ["Name", "Code"];
/// What a wikilink's label is for the link the fixture writes.
export const LABEL = "note";
/// The link as typed, which the code cell keeps.
export const TYPED = "[[note]]";
export const TABLE_TEXT = `${MARKER}\n\n| Name | Code |\n|------|------|\n| ${TYPED} | \`${TYPED}\` |\n\nwikilabels after the table\n`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineOf = (kind) => (name, expected, actual, pass) => ({
  kind,
  name,
  expected,
  actual: actual === undefined ? "unread" : actual,
  pass: actual === undefined ? null : Boolean(pass),
});
const need = lineOf("precondition");
const prop = lineOf("property");
const at = (obj, key) => (obj === undefined || obj === null ? undefined : obj[key]);

/// The run's status from its lines in reading order and the instrument's
/// error, if one ended the reading early.
export function status(lines, error = null) {
  const blocked = lines.findIndex((l) => l.kind === "precondition" && l.pass === false);
  const read = blocked < 0 ? lines : lines.slice(0, blocked);
  if (read.some((l) => l.kind === "property" && l.pass === false)) return "fail";
  if (blocked >= 0 || error || lines.some((l) => l.pass === null)) return "inconclusive";
  return "pass";
}

/// How the link cell reads: the label, the link as typed (the reading
/// before the table widget rendered labels), or anything else.
export function cellReading(text) {
  if (text === undefined || text === null) return "unread";
  if (text === LABEL) return "label";
  if (text === TYPED) return "as typed";
  return "other";
}

/// The lines and status of one reading. `obs.window` is the window id the
/// driver opened the fixture in, `obs.opened` the page's reading once the
/// fixture's editor mounted, and `obs.grid` its reading once the table
/// widget drew the grid.
export function judge(obs) {
  const lines = [];
  const opened = obs.opened;
  lines.push(need("the page read is the window the fixture was opened in", obs.window, at(opened, "w"),
    opened?.w === obs.window));
  lines.push(need("the fixture is open in one editor tab", 1, at(opened, "editors"), opened?.editors === 1));
  lines.push(need("the editor shows the fixture rendered", "rendered", at(opened, "mode"), opened?.mode === "rendered"));
  const grid = obs.grid;
  lines.push(need("the table widget drew one grid with the fixture's header", { wraps: 1, headers: HEADERS },
    grid && { wraps: grid.wraps, headers: grid.headers },
    grid?.wraps === 1 && same(grid.headers, HEADERS)));
  const widths = grid?.rows?.map((row) => row.length);
  lines.push(need("the grid's one body row holds the fixture's two cells", [2], widths, same(widths, [2])));
  const [link, code] = grid?.rows?.[0] ?? [];
  lines.push(prop("the link cell shows the link's label", LABEL, at(link, "text"), link?.text === LABEL));
  lines.push(prop("the link cell holds the label as text: no link and no pill", { links: 0, pills: 0 },
    link && { links: link.links, pills: link.pills }, link?.links === 0 && link.pills === 0));
  lines.push(prop("the code cell keeps the link as typed, in code", { text: TYPED, code: [TYPED] },
    code && { text: code.text, code: code.code }, code?.text === TYPED && same(code.code, [TYPED])));
  return { status: status(lines, obs.error ?? null), reading: cellReading(link?.text), lines };
}

/// The driver's exit status for a judged reading: 10 a fault was observed,
/// 3 inconclusive, 0 held.
export function exitCode(judged) {
  if (judged.status === "fail") return 10;
  if (judged.status === "pass") return 0;
  return 3;
}
