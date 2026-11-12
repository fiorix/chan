// The settings index as data: what every entry must hold for the launcher
// to list it, and the words the index settles for the fields the launcher
// and the menus name too.

import { describe, expect, test } from "vitest";

import "../../state/commands/install";
import { allCommands } from "../../state/commands";
import { SETTINGS_SECTIONS } from "./sections";
import { settingEntry, settingsIndex } from "./settingsIndex";

const index = settingsIndex();

describe("settings index entries", () => {
  test("every id is unique and filed under its own section", () => {
    const ids = index.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of index) {
      expect(spec.id.startsWith(`${spec.section}.`), spec.id).toBe(true);
    }
  });

  test("the entries follow the rail's order and leave no section empty", () => {
    const rail = SETTINGS_SECTIONS.map((section) => section.id);
    const order = index.map((spec) => rail.indexOf(spec.section));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(index.map((spec) => spec.section))).toEqual(new Set(rail));
  });

  test("a toggle and a choice can be written, and an open field cannot", () => {
    for (const spec of index) {
      expect(typeof spec.write, spec.id).toBe(spec.kind === "open" ? "undefined" : "function");
    }
  });

  test("only a choice lists options, each with a value and a word of its own", () => {
    for (const spec of index) {
      if (spec.kind !== "choice") {
        expect(spec.options, spec.id).toBeUndefined();
        continue;
      }
      const options = spec.options ?? [];
      // The embedding models come from the server, so none are known here.
      if (spec.id !== "workspace.embeddingModel") {
        expect(options.length, spec.id).toBeGreaterThan(1);
      }
      expect(new Set(options.map((option) => option.value)).size, spec.id).toBe(options.length);
      expect(new Set(options.map((option) => option.label)).size, spec.id).toBe(options.length);
    }
  });

  test("no two entries of a section share a label", () => {
    for (const section of SETTINGS_SECTIONS) {
      const labels = index.filter((spec) => spec.section === section.id).map((spec) => spec.label);
      expect(new Set(labels).size, section.id).toBe(labels.length);
    }
  });

  test("no label names a toggle by what flipping it does", () => {
    for (const spec of index) {
      expect(spec.label, spec.id).not.toMatch(/^(Toggle|Enable|Disable|Show|Hide)\b/);
    }
  });

  test("a command twin is a registered command", () => {
    const registered = new Set(allCommands().map((command) => command.id));
    const twins = index.filter((spec) => spec.command !== undefined);
    expect(twins.map((spec) => spec.id)).toEqual([
      "browser.leftDock",
      "browser.rightDock",
      "workspace.screenLock.pin",
    ]);
    for (const spec of twins) {
      expect(registered.has(spec.command!), `${spec.id} names ${spec.command}`).toBe(true);
    }
  });

  test("Keyboard Shortcuts is one entry that opens the section", () => {
    const shortcuts = index.filter((spec) => spec.section === "shortcuts");
    expect(shortcuts.map((spec) => [spec.id, spec.label, spec.kind])).toEqual([
      ["shortcuts.grid", "Keyboard Shortcuts", "open"],
    ]);
  });
});

describe("settled words", () => {
  test("the terminal engine is a choice of ghostty and xterm for new terminals", () => {
    const engine = settingEntry("terminal.engine");
    expect(engine.label).toBe("Terminal engine (new terminals)");
    expect(engine.kind).toBe("choice");
    expect(engine.options).toEqual([
      { value: "ghostty", label: "ghostty" },
      { value: "xterm", label: "xterm" },
    ]);
  });

  test("the two docks are toggles twinned with the dock commands", () => {
    expect(
      ["browser.leftDock", "browser.rightDock"].map((id) => {
        const dock = settingEntry(id);
        return [dock.label, dock.kind, dock.command];
      }),
    ).toEqual([
      ["Left file browser dock", "toggle", "app.browser.toggleLeftDock"],
      ["Right file browser dock", "toggle", "app.browser.toggleRightDock"],
    ]);
  });

  test("a surface's body theme carries the surface's name and the three choices", () => {
    expect(
      ["editor", "terminal", "browser", "graph", "dashboard"].map((surface) => {
        const theme = settingEntry(`${surface}.bodyTheme`);
        return [theme.label, theme.options?.map((option) => option.label).join("/")];
      }),
    ).toEqual([
      ["Editor body theme", "Inherit/Light/Dark"],
      ["Terminal body theme", "Inherit/Light/Dark"],
      ["File browser body theme", "Inherit/Light/Dark"],
      ["Graph body theme", "Inherit/Light/Dark"],
      ["Dashboard body theme", "Inherit/Light/Dark"],
    ]);
  });

  test("a former word for a renamed field still finds it", () => {
    expect(settingEntry("terminal.engine").keywords).toContain("Ghostty backend");
    expect(settingEntry("browser.leftDock").keywords).toContain("Left pane");
    expect(settingEntry("browser.rightDock").keywords).toContain("Side panes");
  });

  test("a control named by its caption reads as its field, then the caption", () => {
    expect(settingEntry("global.privacy").label).toBe("Privacy mode");
    expect(settingEntry("global.privacyTerminalMasking").label).toBe(
      "Privacy mode: Also enable terminal secret masking",
    );
    expect(settingEntry("global.paneStrip").label).toBe("Pane strip: Auto-hide");
    expect(settingEntry("browser.vim").label).toBe("Keyboard navigation: Vim navigation");
    // A caption the label leaves out is still searchable.
    expect(settingEntry("terminal.mcpEnv").label).toBe("MCP discovery");
    expect(settingEntry("terminal.mcpEnv").keywords).toContain("Enable in new terminals");
  });
});
