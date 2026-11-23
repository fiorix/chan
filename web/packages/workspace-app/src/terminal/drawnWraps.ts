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
