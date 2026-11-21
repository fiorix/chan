import type { TextRange, VtTerminal } from "@chan/ghostty-web-ng/vt";
import { agentForCommand } from "../state/teamDialog.svelte";
import type { SubmitAgent } from "./submitMode";

// Muse draws a line longer than the terminal is wide by itself: it fills a
// row to the last column, cuts the line there, mid-word when a word falls
// there, and draws the rest on the row below after an absolute cursor move
// or a scroll of the rows above. Neither is an autowrap, so the core marks
// no soft wrap between the two rows, and a copy keeps a line break at the
// cut, which pastes one command as two.
//
// A drawn wrap is that cut: a row that holds text to its last column and
// a row below it that holds text. Where the core also marks a soft wrap
// there, reading it as a drawn wrap gives the text the core's unwrap gives,
// since the row above ends in text and nothing is trimmed at the cut.
// In a session that runs Muse every copy reads a drawn wrap as a soft wrap.
// Muse word-wraps its prose short of the last column, so prose keeps its
// line breaks. A full-width rule (box-drawing characters and spaces only)
// reaches the last column too and is never joined, to the row below it or
// to the row above it. Every other program keeps the core's reading, where
// only the rows the terminal itself wrapped join.

/// Whether a terminal's session runs Muse, by either reading the tab has:
/// the foreground command's name (`program.command`), which follows the
/// program in front, so a Muse started from a shell counts while it runs
/// and stops counting when it exits; or the agent the server derived from
/// the session's spawn command and its `CHAN_AGENT` (`submit_agent`), which
/// holds for a tab spawned as Muse whatever the foreground reading says,
/// as when a shell runs the command without exec and stays in front, or
/// when the platform reads no foreground. Muse's launcher executes
/// `muse-bin-<version>`, so the name is matched as the server matches a
/// spawn command, `muse` as a whole word.
export function sessionRunsMuse(submitAgent: SubmitAgent | undefined, command: string | null | undefined): boolean {
  return submitAgent === "muse" || (!!command && agentForCommand(command) === "muse");
}

/// A row of box-drawing characters and spaces only.
const RULE = /^[\u2500-\u257f ]+$/;

/// The text of cells `from` to `to` of row `row`, 0 the oldest history row,
/// as a copy reads it: trimmed, so a blank cell alone reads empty. Null when
/// the core cannot format it.
function rowText(core: VtTerminal, row: number, from: number, to: number): string | null {
  return core.plainText({ startCol: from, startRow: row, endCol: to, endRow: row });
}

/// Whether row `row` continues the row above it by a drawn wrap. The last
/// cell is read first, one formatter call, since reading a history row's
/// cells costs a few wasm calls a cell and a whole-history copy asks this
/// of every row; both whole rows are read only when that cell holds text.
/// A row past the last reads empty, so it continues nothing.
function drawnWrapAt(core: VtTerminal, row: number, cols: number): boolean {
  if (row < 1 || !rowText(core, row - 1, cols - 1, cols - 1)) return false;
  const above = rowText(core, row - 1, 0, cols - 1);
  const below = rowText(core, row, 0, cols - 1);
  return above !== null && !!below && !RULE.test(above) && !RULE.test(below);
}

/// Whether row `row` of the history and the screen, 0 the oldest history
/// row, continues the row above it by a drawn wrap.
export function drawnWrapAbove(core: VtTerminal, row: number): boolean {
  return drawnWrapAt(core, row, core.getDimensions().cols);
}

/// The text of `range` as a copy reads it (`VtTerminal.plainText`), with
/// every drawn wrap in it joined as a soft wrap is: the range is read in
/// pieces cut at its drawn wraps, each piece but the last ending at the
/// last column of a row that holds text there, so the formatter trims
/// nothing at a cut, and the pieces are joined with nothing between them.
/// Null when the range holds no drawn wrap or the core cannot format a
/// piece, for the caller's own read.
export function textAcrossDrawnWraps(core: VtTerminal, range: TextRange): string | null {
  const { cols } = core.getDimensions();
  const forwards =
    range.startRow < range.endRow || (range.startRow === range.endRow && range.startCol <= range.endCol);
  const start = forwards ? { col: range.startCol, row: range.startRow } : { col: range.endCol, row: range.endRow };
  const end = forwards ? { col: range.endCol, row: range.endRow } : { col: range.startCol, row: range.startRow };
  let text = "";
  let from = start;
  for (let row = start.row + 1; row <= end.row; row++) {
    if (!drawnWrapAt(core, row, cols)) continue;
    const piece = core.plainText({ startCol: from.col, startRow: from.row, endCol: cols - 1, endRow: row - 1 });
    if (piece === null) return null;
    text += piece;
    from = { col: 0, row };
  }
  if (from === start) return null;
  const tail = core.plainText({ startCol: from.col, startRow: from.row, endCol: end.col, endRow: end.row });
  return tail === null ? null : text + tail;
}

/// Copy scrollback's text with every drawn wrap joined: the history and
/// the screen, as a selection of all of them reads. Null when they hold no
/// drawn wrap or the core cannot format them.
export function scrollbackAcrossDrawnWraps(core: VtTerminal): string | null {
  const { cols, rows } = core.getDimensions();
  const last = core.getScrollbackLength() + rows - 1;
  return textAcrossDrawnWraps(core, { startCol: 0, startRow: 0, endCol: cols - 1, endRow: last });
}
