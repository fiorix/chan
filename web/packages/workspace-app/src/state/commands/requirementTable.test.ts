// The capability-requirement table over the full catalog. Importing
// install registers every command module; these tests then prove the
// invariants the requirement gate relies on: every entry declares one of
// the four requirement values (a runtime guard for plain-JS callers that
// bypass the compiler), every terminal-only dispatch id stays satisfiable
// in a window that holds terminals alone, and the per-capability id lists
// nest the way the capability table nests. The snapshot pins each
// capability set's visible commands so a reclassification shows up as an
// explicit snapshot review.
//
// A standalone terminal window appears twice here, because its capabilities
// depend on its host: without a filesystem surface it is the narrow
// terminals-only window, and with one it also browses and edits.

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

/// Every capability set a window can boot with: the mode, plus whether the
/// serving tenant offered a filesystem (which only a standalone terminal
/// window's capabilities read).
const SHAPES: readonly { name: string; mode: WindowMode; tenantFiles: boolean }[] = [
  { name: "workspace", mode: "workspace", tenantFiles: false },
  { name: "terminal", mode: "terminal", tenantFiles: false },
  { name: "terminal+files", mode: "terminal", tenantFiles: true },
  { name: "control", mode: "control", tenantFiles: false },
];

function sortedCatalog() {
  return [...allCommands()].sort((a, b) => a.id.localeCompare(b.id));
}

function idsForMode(mode: WindowMode, tenantFiles = false): Set<string> {
  const caps = capsForMode(mode, tenantFiles);
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
    const terminalCaps = capsForMode("terminal", false);
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
    for (const shape of SHAPES) {
      const caps = capsForMode(shape.mode, shape.tenantFiles);
      lines.push(`# ${shape.name}`);
      for (const command of catalog) {
        if (requirementAllows(command.requirement, caps)) {
          lines.push(`${command.id} ${command.requirement}`);
        }
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("nests the id sets: terminals within terminals+files within workspace", () => {
    const terminal = idsForMode("terminal");
    const files = idsForMode("terminal", true);
    const workspace = idsForMode("workspace");
    for (const id of terminal) {
      expect(files.has(id), id).toBe(true);
    }
    // Strict: the same window with a filesystem behind it offers the file
    // family on top of everything the terminals-only one offers.
    expect(files.size).toBeGreaterThan(terminal.size);
    for (const id of files) {
      expect(workspace.has(id), id).toBe(true);
    }
  });
});
