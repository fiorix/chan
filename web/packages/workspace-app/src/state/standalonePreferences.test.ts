// @vitest-environment jsdom
//
// A standalone window has no `workspace.info`, so any surface that reads its
// preferences straight off it silently renders on defaults. It renders a full
// editor and a file browser, so every reader of a user-visible setting goes
// through `currentPreferences()`, which falls back to the machine preferences
// the standalone tenant serves from `/api/config`. Each reader is driven here
// with no workspace info and the machine preferences set.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { __testSetStandalonePreferences, currentPreferences, workspace } from "./store.svelte";
import { allCommands } from "./commands";
import "./commands/install";
import { defaultDateFormatId } from "../editor/commands/date_macros";
import { chanMarkdown } from "../editor/markdown/grammar";
import { dateDecorations } from "../editor/widgets/date";
import SourceComponent from "../editor/Source.svelte";
import SettingsOverlay from "../components/SettingsOverlay.svelte";
import App from "../App.svelte";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers } from "../demo/timers";
import { preferences } from "../__tests__/standalone";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

installEditorDom();
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});

const mounted: Array<Record<string, unknown>> = [];
const views: EditorView[] = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  for (const v of views.splice(0)) v.destroy();
  unmountWysiwygs();
  document.body.innerHTML = "";
  __testSetStandalonePreferences(null);
  document.documentElement.removeAttribute("data-editor-theme");
  document.documentElement.style.removeProperty("--chan-editor-body-size");
  document.documentElement.style.removeProperty("--chan-editor-source-size");
});

describe("a window with no workspace still reads its machine preferences", () => {
  test("currentPreferences falls back to what the standalone tenant served", () => {
    expect(currentPreferences()).toBeNull();
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(currentPreferences()?.date_format).toBe("mdy-slash");
  });

  test("the date macros honour the standalone date_format", () => {
    expect(defaultDateFormatId()).toBe("iso");
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(defaultDateFormatId()).toBe("mdy-slash");
  });
});

describe("each reader of a setting", () => {
  test("Wysiwyg takes its line spacing", async () => {
    __testSetStandalonePreferences(preferences({ line_spacing: "compact" }));
    const { target } = await mountWysiwyg({ value: "text" });
    expect(target.querySelector<HTMLElement>(".md-wysiwyg-cm6")?.dataset.density).toBe("compact");
  });

  test("Source takes its line spacing", () => {
    __testSetStandalonePreferences(preferences({ line_spacing: "compact" }));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(SourceComponent, {
        target,
        props: { autoFocus: false, path: "note.md", value: "text" } as ComponentProps<typeof SourceComponent>,
      }),
    );
    flushSync();
    expect(target.querySelector<HTMLElement>(".md-source")?.dataset.density).toBe("compact");
  });

  test("date pills read an ambiguous date in the configured format", () => {
    // 03/04/2025 is a date in both slash formats; the preference decides.
    const doc = "due 03/04/2025";
    const pillFormats = (): string[] => {
      const parent = document.createElement("div");
      document.body.append(parent);
      const view = new EditorView({
        parent,
        state: EditorState.create({ doc, extensions: [chanMarkdown(), dateDecorations()] }),
      });
      views.push(view);
      return [...parent.querySelectorAll<HTMLElement>(".cm-md-date-pill")].map((p) => p.dataset.formatId!);
    };
    __testSetStandalonePreferences(preferences({ date_format: "dmy-slash" }));
    expect(pillFormats()).toEqual(["dmy-slash"]);
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(pillFormats()).toEqual(["mdy-slash"]);
  });

  test("Settings applies the editor font size while closed", () => {
    __testSetStandalonePreferences(preferences({ editor_font_size: 18 }));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(SettingsOverlay, { target }));
    flushSync();
    expect(document.documentElement.style.getPropertyValue("--chan-editor-body-size")).toBe("18px");
  });

  test("the terminal engine command names the configured engine", () => {
    const title = () => allCommands().find((c) => c.id === "app.terminal.backend.toggle")!.title;
    expect(title()).toMatch(/^Terminal engine: xterm /);
    __testSetStandalonePreferences(preferences({ terminal: { ...preferences().terminal, ghostty: true } }));
    expect(title()).toMatch(/^Terminal engine: ghostty /);
  });

  test("the app applies the editor theme", async () => {
    const timers = trackTimers();
    const app: Array<Record<string, unknown>> = [];
    try {
      installDemoWorkspace({
        metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 0, textCount: 0 },
        files: [],
      });
      const target = document.createElement("div");
      document.body.append(target);
      app.push(mount(App, { target }));
      await vi.waitFor(() => expect(workspace.info).not.toBeNull());
      for (let i = 0; i < 4; i += 1) await tick();

      workspace.info = null;
      __testSetStandalonePreferences(preferences({ editor_theme: "word" }));
      for (let i = 0; i < 4; i += 1) await tick();
      expect(document.documentElement.getAttribute("data-editor-theme")).toBe("word");
    } finally {
      await teardownDemoApp({ mounted: app, timers });
    }
  });
});
