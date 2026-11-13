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
//
// What a choice lists is not a requirement: the Dashboard's slide choices
// read the capabilities of the window that booted, which are fixed as the
// modules load. So the slides each window shape lists are read in a module
// graph booted as that window.

import { afterEach, describe, it, expect, vi } from "vitest";
import { serveMeta } from "../../__tests__/standalone";
import { allCommands, availableCommands, dispatchAllowsCommand, requirementAllows } from "../commands";
import { capsForMode, type WindowMode } from "../windowCaps";
import { TERMINAL_ONLY_COMMANDS, windowModeAllowsCommand } from "../windowMode";

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
  it.each(SHAPES)("offers and dispatches New dashboard in $name windows unless they lack a tab strip", (shape) => {
    const caps = capsForMode(shape.mode, shape.tenantFiles, shape.tenantDrafts);
    const mode = { terminalOnly: !caps.files, terminalControl: shape.mode === "control" };
    const context = {
      ...mode, caps, activeSurface: "terminal" as const, activeSide: "a" as const,
      activeTabId: "terminal-1", activeExtensionId: null,
    };
    // A control window hides its tab strip, so a Dashboard would cover its
    // one terminal with nothing to switch back.
    const strip = shape.mode !== "control";
    expect(availableCommands(context).some((c) => c.id === "app.dashboard.open")).toBe(strip);
    expect(windowModeAllowsCommand("app.dashboard.open", mode)).toBe(strip);
    expect(dispatchAllowsCommand("app.dashboard.open", caps)).toBe(true);
    // Go to slide and Shown slides are offered wherever a Dashboard is. The
    // slides they list differ by window, which the next group reads.
    const dashboard = availableCommands({ ...context, activeSurface: "dashboard" });
    expect(dashboard.some((c) => c.id === "app.dashboard.slide")).toBe(true);
    expect(dashboard.some((c) => c.id === "app.dashboard.slides")).toBe(true);
  });

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
    // entries -- `app.window.confirmClose` (the OS close button),
    // `app.tab.jump`, `app.launcher.toggle`. The dispatch gate runs for
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

describe("the Dashboard's slide choices, by window", () => {
  const href = window.location.href;

  afterEach(() => {
    serveMeta("chan-files", false);
    serveMeta("chan-drafts", false);
    window.history.replaceState({}, "", href);
    vi.resetModules();
  });

  it.each(SHAPES)("list the slides a $name window can show", async (shape) => {
    // Boot a module graph as this window: its `?kind=` marker and the
    // tenant's capability metas, in place before the state modules load.
    vi.resetModules();
    window.history.replaceState({}, "", shape.mode === "workspace" ? "/" : `/?kind=${shape.mode}`);
    serveMeta("chan-files", shape.tenantFiles);
    serveMeta("chan-drafts", shape.tenantDrafts);
    const { windowCaps } = await import("../windowCaps");
    expect(windowCaps).toEqual(capsForMode(shape.mode, shape.tenantFiles, shape.tenantDrafts));
    const { commandById, commandContext } = await import("../commands");
    await import("./dashboard");
    const { resetLayout } = await import("../../__tests__/tabs");
    resetLayout([{ kind: "dashboard", id: "dashboard-1", title: "Dashboard" }]);
    const ctx = commandContext();
    expect(ctx.activeSurface).toBe("dashboard");

    // Metrics and About anywhere, Workspace and Search only over a
    // workspace, in the dashboard menu's order.
    const slides = windowCaps.workspace
      ? ["Metrics", "Workspace", "Search", "About"]
      : ["Metrics", "About"];
    for (const id of ["app.dashboard.slide", "app.dashboard.slides"]) {
      const command = commandById(id)!;
      expect(command.available(ctx), id).toBe(true);
      expect(command.options!(ctx).map((option) => option.label), id).toEqual(slides);
    }
  });
});
