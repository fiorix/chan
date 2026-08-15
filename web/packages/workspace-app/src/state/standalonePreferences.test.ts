// A standalone window has no `workspace.info`, so any surface that reads its
// preferences straight off it silently renders on defaults. That was harmless
// while such a window held only terminals; it now renders a full editor and a
// file browser, so every reader of a user-visible setting has to go through
// `currentPreferences()`, which falls back to the machine preferences the
// standalone tenant serves from `/api/config`.
//
// The behavioural half of this is asserted through the date macros (pure TS,
// callable here); the surfaces that only exist inside a mounted editor are
// pinned by source, which is what the repo does for one-line reads.

import { describe, expect, test, afterEach } from "vitest";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences, currentPreferences } from "./store.svelte";
import { defaultDateFormatId } from "../editor/commands/date_macros";

import appSource from "../App.svelte?raw";
import wysiwygSource from "../editor/Wysiwyg.svelte?raw";
import sourceEditorSource from "../editor/Source.svelte?raw";
import dateWidgetSource from "../editor/widgets/date.ts?raw";
import settingsSource from "../components/SettingsOverlay.svelte?raw";
import terminalCommandsSource from "./commands/terminal.ts?raw";

function machinePreferences(over: Partial<Preferences>): Preferences {
  return { date_format: "mdy-slash", line_spacing: "relaxed", ...over } as unknown as Preferences;
}

afterEach(() => {
  __testSetStandalonePreferences(null);
});

describe("a window with no workspace still reads its machine preferences", () => {
  test("currentPreferences falls back to what the standalone tenant served", () => {
    expect(currentPreferences()).toBeNull();
    __testSetStandalonePreferences(machinePreferences({}));
    expect(currentPreferences()?.date_format).toBe("mdy-slash");
  });

  test("the date macros honour the standalone date_format", () => {
    // Without a workspace this used to resolve to the ISO fallback whatever
    // the user had configured.
    expect(defaultDateFormatId()).toBe("iso");
    __testSetStandalonePreferences(machinePreferences({}));
    expect(defaultDateFormatId()).toBe("mdy-slash");
  });
});

describe("editor surfaces read preferences through currentPreferences", () => {
  const pins: [string, string, RegExp][] = [
    ["App.svelte editor theme", appSource, /const theme = currentPreferences\(\)\?\.editor_theme;/],
    [
      "Wysiwyg line spacing",
      wysiwygSource,
      /editorDensity\(currentPreferences\(\)\?\.line_spacing\)/,
    ],
    [
      "Source line spacing",
      sourceEditorSource,
      /editorDensity\(currentPreferences\(\)\?\.line_spacing\)/,
    ],
    ["date pill detection", dateWidgetSource, /currentPreferences\(\)\?\.date_format/],
    [
      "Settings editor font size",
      settingsSource,
      /applyEditorFontSize\(currentPreferences\(\)\?\.editor_font_size\)/,
    ],
    ["terminal backend", terminalCommandsSource, /currentPreferences\(\)\?\.terminal\.ghostty/],
  ];

  for (const [name, source, pattern] of pins) {
    test(name, () => {
      expect(source).toMatch(pattern);
    });
  }
});
