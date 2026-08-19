// The capability-requirement table over the full catalog. Importing
// install registers every command module; these tests then prove the
// invariants the requirement gate relies on: every entry declares one of
// the five requirement values (a runtime guard for plain-JS callers that
// bypass the compiler), every terminal-only dispatch id stays satisfiable
// in a window that holds terminals alone, and the per-capability id lists
// nest the way the capability table nests. The snapshot pins each
// capability set's visible commands so a reclassification shows up as an
// explicit snapshot review.
//
// A standalone terminal window appears three times here, because its
// capabilities depend on its host: without a filesystem surface it is the
// narrow terminals-only window, with one it also browses and edits, and
// with a draft store behind that it creates drafts too.

import { describe, it, expect } from "vitest";
import { allCommands, dispatchAllowsCommand, requirementAllows } from "../commands";
import { capsForMode, type WindowMode } from "../windowCaps";
import { TERMINAL_ONLY_COMMANDS } from "../windowMode";

import "./install";

const REQUIREMENTS: ReadonlySet<string> = new Set([
  "any",
  "terminal",
  "files",
  "drafts",
  "workspace",
]);

/// Every capability set a window can boot with: the mode, plus whether the
/// serving tenant offered a filesystem and a draft store (which only a
/// standalone terminal window's capabilities read).
const SHAPES: readonly {
  name: string;
  mode: WindowMode;
  tenantFiles: boolean;
  tenantDrafts: boolean;
}[] = [
  { name: "workspace", mode: "workspace", tenantFiles: false, tenantDrafts: false },
  { name: "terminal", mode: "terminal", tenantFiles: false, tenantDrafts: false },
  { name: "terminal+files", mode: "terminal", tenantFiles: true, tenantDrafts: false },
  {
    name: "terminal+files+drafts",
    mode: "terminal",
    tenantFiles: true,
    tenantDrafts: true,
  },
  { name: "control", mode: "control", tenantFiles: false, tenantDrafts: false },
];

function sortedCatalog() {
  return [...allCommands()].sort((a, b) => a.id.localeCompare(b.id));
}

function idsForMode(
  mode: WindowMode,
  tenantFiles = false,
  tenantDrafts = false,
): Set<string> {
  const caps = capsForMode(mode, tenantFiles, tenantDrafts);
  return new Set(
    allCommands()
      .filter((c) => requirementAllows(c.requirement, caps))
      .map((c) => c.id),
  );
}

describe("command requirement table", () => {
  it("declares one of the five requirement values on every command", () => {
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
    const terminalCaps = capsForMode("terminal", false, false);
    for (const command of allCommands()) {
      if (!TERMINAL_ONLY_COMMANDS.has(command.id)) continue;
      expect(
        requirementAllows(command.requirement, terminalCaps),
        command.id,
      ).toBe(true);
    }
  });

  it("lets every window-level id dispatch in a window that has no workspace", () => {
    // TERMINAL_ONLY_COMMANDS is the set of ids that need no workspace. Some of
    // them are dispatch-only: they are fired by chords and by the desktop's
    // `chan:command` bridge and have no launcher row, so they are NOT catalog
    // entries -- `app.window.confirmClose` (the OS close button), the find
    // family, `app.tab.jump`, `app.launcher.toggle`. The dispatch gate runs for
    // any window that is more than terminals, so it has to allow them there
    // too; dropping one leaves the desktop holding a close the SPA never
    // answers.
    const caps = capsForMode("terminal", true, false);
    expect(caps.workspace).toBe(false);
    for (const id of TERMINAL_ONLY_COMMANDS) {
      expect(dispatchAllowsCommand(id, caps), id).toBe(true);
    }
  });

  it("still fails closed on an id nothing classifies", () => {
    // The other half of the rule: an id in neither table is a workspace action
    // as far as a reduced window knows, so it does not run there.
    const caps = capsForMode("terminal", true, true);
    expect(dispatchAllowsCommand("app.graph.toggle", caps)).toBe(false);
    expect(dispatchAllowsCommand("app.totally.unknown", caps)).toBe(false);
    // A workspace window runs everything, classified or not.
    expect(
      dispatchAllowsCommand("app.totally.unknown", capsForMode("workspace", false, false)),
    ).toBe(true);
  });

  it("pins the per-mode command table", () => {
    const lines: string[] = [];
    const catalog = sortedCatalog();
    for (const shape of SHAPES) {
      const caps = capsForMode(shape.mode, shape.tenantFiles, shape.tenantDrafts);
      lines.push(`# ${shape.name}`);
      for (const command of catalog) {
        if (requirementAllows(command.requirement, caps)) {
          lines.push(`${command.id} ${command.requirement}`);
        }
      }
    }
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("nests the id sets: terminal within files within drafts within workspace", () => {
    const terminal = idsForMode("terminal");
    const files = idsForMode("terminal", true);
    const drafts = idsForMode("terminal", true, true);
    const workspace = idsForMode("workspace");
    for (const id of terminal) {
      expect(files.has(id), id).toBe(true);
    }
    // Strict at every link: each capability opens commands the narrower
    // window does not offer.
    expect(files.size).toBeGreaterThan(terminal.size);
    for (const id of files) {
      expect(drafts.has(id), id).toBe(true);
    }
    expect(drafts.size).toBeGreaterThan(files.size);
    for (const id of drafts) {
      expect(workspace.has(id), id).toBe(true);
    }
    expect(workspace.size).toBeGreaterThan(drafts.size);
  });
});
