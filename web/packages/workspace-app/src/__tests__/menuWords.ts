// Where a menu row, a help row or a chrome button takes its words. A test
// over a surface lists one source per row it draws and holds each drawn
// label to it, so a row that performs a catalog action cannot type that
// action's words itself, and a row that keeps its own says why.

import { expect } from "vitest";

import { commandById, commandContext, type CommandContext } from "../state/commands";
import { SHORTCUTS } from "../state/shortcuts";

export type WordSource =
  /// The title of the registered command with this id.
  | { command: string }
  /// The shortcut table's label, for an id the catalog does not hold.
  | { shortcut: string }
  /// The label of one option of a choice command.
  | { choice: string; option: string }
  /// The surface's own words, and why no command names them.
  | { own: string; because: string };

/// The words `source` stands for. Fails when it names a command, a shortcut
/// or an option that does not exist, so a mistyped id cannot agree with a
/// surface that fell back to printing the same id.
export function wordsOf(source: WordSource, ctx: CommandContext = commandContext()): string {
  if ("own" in source) {
    expect(source.because, `${source.own} says why it keeps its own words`).not.toBe("");
    return source.own;
  }
  if ("shortcut" in source) {
    const shortcut = SHORTCUTS.find((entry) => entry.id === source.shortcut);
    expect(shortcut, `shortcut ${source.shortcut}`).toBeDefined();
    expect(commandById(source.shortcut), `${source.shortcut} has a command to read`).toBeUndefined();
    return shortcut!.label;
  }
  if ("choice" in source) {
    const command = commandById(source.choice);
    expect(command?.kind, `choice ${source.choice}`).toBe("choice");
    const option = command!.options!(ctx).find((candidate) => candidate.id === source.option);
    expect(option, `${source.choice} option ${source.option}`).toBeDefined();
    return option!.label;
  }
  const command = commandById(source.command);
  expect(command, `command ${source.command}`).toBeDefined();
  return command!.title;
}

/// Hold the labels a surface drew, in order, to their sources.
export function expectWords(
  labels: readonly string[],
  sources: readonly WordSource[],
  ctx: CommandContext = commandContext(),
): void {
  expect(labels).toEqual(sources.map((source) => wordsOf(source, ctx)));
}
