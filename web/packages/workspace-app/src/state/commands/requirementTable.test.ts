// The capability-requirement table over the full catalog. Importing
// install registers every command module; these tests then prove the
// invariants the requirement gate relies on: every entry declares one of
// the four requirement values (a runtime guard for plain-JS callers that
// bypass the compiler), every terminal-only dispatch id stays satisfiable
// in a terminal window, and the per-mode id lists nest the way the
// capability table nests. The snapshot pins each mode's visible set so a
// reclassification shows up as an explicit snapshot review.

import { describe, it, expect } from "vitest";
import { allCommands, requirementAllows } from "../commands";
import { capsForMode, type WindowMode } from "../windowCaps";
import { TERMINAL_ONLY_COMMANDS } from "../windowMode";

import "./install";

const REQUIREMENTS: ReadonlySet<string> = new Set([
  "any",
  "terminal",
  "files",
  "workspace",
]);

const MODES: readonly WindowMode[] = [
  "workspace",
  "terminal",
  "control",
  "files",
];

function sortedCatalog() {
  return [...allCommands()].sort((a, b) => a.id.localeCompare(b.id));
}

function idsForMode(mode: WindowMode): Set<string> {
  const caps = capsForMode(mode);
  return new Set(
    allCommands()
      .filter((c) => requirementAllows(c.requirement, caps))
      .map((c) => c.id),
  );
}

describe("command requirement table", () => {
  it("declares one of the four requirement values on every command", () => {
    const catalog = allCommands();
    expect(catalog.length).toBeGreaterThan(0);
    for (const command of catalog) {
      expect(REQUIREMENTS.has(command.requirement), command.id).toBe(true);
    }
  });

  it("keeps every terminal-only dispatch id satisfiable in a terminal window", () => {
    // TERMINAL_ONLY_COMMANDS is the dispatch allow-list for a terminal
    // window; a catalog entry on that list with a files or workspace
    // requirement would be dispatchable but never offered, so the two
    // tables would disagree.
    const terminalCaps = capsForMode("terminal");
    for (const command of allCommands()) {
      if (!TERMINAL_ONLY_COMMANDS.has(command.id)) continue;
      expect(
        requirementAllows(command.requirement, terminalCaps),
        command.id,
      ).toBe(true);
    }
  });

  it("pins the per-mode command table", () => {
    const lines: string[] = [];
    const catalog = sortedCatalog();
    for (const mode of MODES) {
      const caps = capsForMode(mode);
      lines.push(`# ${mode}`);
      for (const command of catalog) {
        if (requirementAllows(command.requirement, caps)) {
          lines.push(`${command.id} ${command.requirement}`);
        }
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("nests the mode id sets: terminal within files within workspace", () => {
    const terminal = idsForMode("terminal");
    const files = idsForMode("files");
    const workspace = idsForMode("workspace");
    for (const id of terminal) {
      expect(files.has(id), id).toBe(true);
    }
    // Strict: a Files window offers the file family on top of everything a
    // terminal window offers.
    expect(files.size).toBeGreaterThan(terminal.size);
    for (const id of files) {
      expect(workspace.has(id), id).toBe(true);
    }
  });
});
