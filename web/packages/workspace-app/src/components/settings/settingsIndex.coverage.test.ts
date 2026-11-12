// The settings index against the mounted overlay, section by section: every
// field and every control of a field that the overlay renders carries the
// anchor of an index entry, the index offers nothing the overlay does not
// render, the gates of both agree, and the words on screen are the entry's.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../../api/client";
import type { Preferences } from "../../api/types";
import { recordingContext2d } from "../../__tests__/canvas";
import {
  closeSettings,
  openSettings,
  settingsPreferences,
  settleSettings,
} from "../../__tests__/settings";
import { demoWorkspaceInfo } from "../../demo/data";
import { screensaver } from "../../state/screensaver.svelte";
import { __testSetStandalonePreferences, workspace } from "../../state/store.svelte";
import { NO_TITLEBAR_CHROME, windowTabBar } from "../../state/windowTabBar.svelte";
import { resetShownPreferencesForTests } from "./preferenceState.svelte";
import { SETTINGS_SECTIONS } from "./sections";
import { UNINDEXED_FIELDS, settingEntry, settingsIndex } from "./settingsIndex";
import { resetWorkspaceStateForTests } from "./workspace/workspaceState.svelte";

const RAIL = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section.label]));

/// Headings of the rendered fields that carry no anchor, over every case.
const unanchored = new Set<string>();

function text(node: Element | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/// The ids the index offers for `section` in this window, in order.
function offered(section: string): string[] {
  return settingsIndex()
    .filter((spec) => spec.section === section && spec.available())
    .map((spec) => spec.id);
}

/// The anchors the mounted section renders, in document order.
function anchors(target: HTMLElement): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>(".content [data-setting]")];
}

/// The entry of the closest anchor around `control`, or null in a field the
/// index leaves out.
function entryAround(control: Element): ReturnType<typeof settingEntry> | null {
  const anchor = control.closest<HTMLElement>("[data-setting]");
  return anchor ? settingEntry(anchor.dataset.setting!) : null;
}

/// Hold what `target` renders of `section` to the index: the anchors, the
/// kinds of the controls and the words. Returns the rendered ids.
function expectRenderedIsIndexed(target: HTMLElement, section: string): string[] {
  const rendered = anchors(target);
  const ids = rendered.map((anchor) => anchor.dataset.setting!);
  expect(ids).toEqual(offered(section));

  // Every field-shaped thing is an entry, or is named as left out.
  for (const field of target.querySelectorAll<HTMLElement>(".content section.field")) {
    if (field.dataset.setting !== undefined) continue;
    const heading = text(field.querySelector("h3"));
    expect(Object.keys(UNINDEXED_FIELDS), `field "${heading}" has no index entry`).toContain(heading);
    unanchored.add(heading);
  }
  for (const row of target.querySelectorAll<HTMLElement>(".content .colour-row")) {
    expect(row.dataset.setting, `colour row "${text(row.querySelector("label"))}"`).toBeDefined();
  }

  // Every toggle and every choice on screen is an entry of that kind, one
  // control to an entry.
  const controls = [
    ...[...target.querySelectorAll('.content label.pill input[type="checkbox"]')].map(
      (control) => ({ control, kind: "toggle" }),
    ),
    ...[...target.querySelectorAll('.content [role="radiogroup"], .content select')].map(
      (control) => ({ control, kind: "choice" }),
    ),
  ];
  const claimed = new Set<string>();
  for (const { control, kind } of controls) {
    const entry = entryAround(control);
    if (!entry) {
      expect(Object.keys(UNINDEXED_FIELDS)).toContain(text(control.closest(".field")?.querySelector("h3")));
      continue;
    }
    expect(entry.kind, `${entry.id} is rendered as a ${kind}`).toBe(kind);
    expect(claimed.has(entry.id), `two controls render ${entry.id}`).toBe(false);
    claimed.add(entry.id);
  }
  for (const id of ids) {
    const entry = settingEntry(id);
    if (entry.kind !== "open") expect(claimed.has(id), `${id} renders no ${entry.kind}`).toBe(true);
  }

  // The words on screen are the entry's own.
  for (const anchor of rendered) {
    const entry = settingEntry(anchor.dataset.setting!);
    expect([entry.heading, `${entry.heading}: ${entry.caption}`], entry.id).toContain(entry.label);
    if (anchor.matches("section.field")) {
      expect(text(anchor.querySelector(".meta h3")), entry.id).toBe(entry.heading);
      // A pill with a word of its own shows the entry's caption.
      if (entry.kind === "toggle" && entry.caption !== entry.heading) {
        expect(text(anchor.querySelector("label.pill:not([data-setting]) span")), entry.id).toBe(entry.caption);
      }
    } else if (anchor.matches(".keymap-mount")) {
      expect(entry.label).toBe(RAIL.get(section));
    } else {
      const caption = anchor.querySelector(":scope > span, :scope > label, :scope > button");
      expect(text(caption), entry.id).toBe(entry.caption);
    }
    if (entry.kind === "choice") {
      const words = [...anchor.querySelectorAll('[role="radiogroup"] .pill span, select option')].map(text);
      expect(words, entry.id).toEqual(entry.options!.map((option) => option.label));
    }
  }
  return ids;
}

/// Open `section` over `preferences`, which this window also holds as its
/// served record, and hold the overlay and the index to each other. A
/// workspace control renders part of itself once its own state has loaded,
/// so the reading is taken when it holds.
async function expectCovered(section: string, preferences: Preferences = settingsPreferences()): Promise<string[]> {
  if (workspace.info) workspace.info = { ...workspace.info, preferences };
  else __testSetStandalonePreferences(preferences);
  const { target } = await openSettings(RAIL.get(section)!, preferences as unknown as Record<string, unknown>);
  await settleSettings();
  return vi.waitFor(() => expectRenderedIsIndexed(target, section));
}

afterEach(() => {
  closeSettings();
  __testSetStandalonePreferences(null);
  workspace.info = null;
  resetShownPreferencesForTests();
  resetWorkspaceStateForTests();
  windowTabBar.available = false;
  windowTabBar.preferred = false;
  windowTabBar.on = false;
  windowTabBar.chrome = NO_TITLEBAR_CHROME;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the overlay renders exactly the index, section by section", () => {
  test.each(["global", "editor", "terminal", "browser", "graph", "dashboard", "search", "shortcuts"])(
    "%s, over a fresh config",
    async (section) => {
      const ids = await expectCovered(section);
      expect(ids.length).toBeGreaterThan(0);
    },
  );

  test("terminal, with custom colours on, adds the contrast and the three colours", async () => {
    const ids = await expectCovered("terminal", {
      ...settingsPreferences(),
      terminal_colors: {
        mode: "custom",
        custom: { background: "#000000", foreground: "#ffffff", cursor: "#00ff00", contrast: "auto" },
      },
    });
    expect(ids).toEqual(
      expect.arrayContaining([
        "terminal.ansiContrast",
        "terminal.colors.background",
        "terminal.colors.foreground",
        "terminal.colors.cursor",
      ]),
    );
  });

  test("graph, with custom colours on, adds a row per node hue", async () => {
    const ids = await expectCovered("graph", {
      ...settingsPreferences(),
      graph_colors: { mode: "custom" },
    });
    expect(ids.filter((id) => id.startsWith("graph.colors."))).toHaveLength(8);
  });

  test("global, where the window can put its tabs in the title bar, offers that row", async () => {
    windowTabBar.available = true;
    const ids = await expectCovered("global");
    expect(ids).toContain("global.titlebarTabs");
    expect(ids).toContain("global.paneStrip");
  });

  test("global, with the tabs in the title bar, has no pane strip to hide", async () => {
    windowTabBar.available = true;
    windowTabBar.on = true;
    const ids = await expectCovered("global");
    expect(ids).toContain("global.titlebarTabs");
    expect(ids).not.toContain("global.paneStrip");
  });

  test("a window with no workspace has no This workspace section, and the index offers none of it", async () => {
    const { target } = await openSettings("Global");
    const tabs = [...target.querySelectorAll(".section-tab")].map(text);
    expect(tabs).not.toContain("This workspace");
    expect(offered("workspace")).toEqual([]);
  });
});

describe("This workspace renders exactly the index", () => {
  let lock: { enabled: boolean; timeout_secs: number; theme: "plain" | "matrix"; pin_set: boolean };
  let embeddings: boolean;

  beforeEach(() => {
    lock = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: false };
    embeddings = true;
    vi.spyOn(api, "indexStatus").mockRejectedValue(new Error("no index"));
    vi.spyOn(api, "reportsState").mockResolvedValue({ enabled: false });
    vi.spyOn(api, "buildInfo").mockImplementation(async () => ({
      version: "0",
      build: "test",
      features: { embeddings },
    }));
    vi.spyOn(api, "semanticState").mockResolvedValue({
      mode: "bm25",
      model_present: true,
      model_name: "bge-small",
      model_path: "/models/bge-small",
      model_size_bytes: 1,
      semantic_enabled: false,
    });
    vi.spyOn(api, "semanticModels").mockResolvedValue({
      current_model: "bge-small",
      models: [
        {
          id: "bge-small",
          label: "BGE small",
          dim: 384,
          size_label: "130 MB",
          note: "",
          default: true,
          downloaded: true,
          current: true,
        },
        {
          id: "bge-m3",
          label: "BGE M3",
          dim: 1024,
          size_label: "2.2 GB",
          note: "",
          default: false,
          downloaded: false,
          current: false,
        },
      ],
    });
    vi.spyOn(api, "excludedDirs").mockResolvedValue({ defaults: [], workspace: [], effective: [] });
    vi.spyOn(api, "screensaverState").mockImplementation(async () => ({ ...lock }));
    // The lock's previews draw on a canvas.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      recordingContext2d().ctx as unknown as RenderingContext,
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    workspace.info = demoWorkspaceInfo(
      {
        metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
        files: [],
      },
      settingsPreferences(),
    );
    Object.assign(screensaver, { ...lock, locked: false, loaded: false });
  });

  afterEach(() => {
    Object.assign(screensaver, {
      enabled: false,
      timeout_secs: 300,
      theme: "plain",
      pin_set: false,
      locked: false,
      loaded: false,
    });
  });

  test("with the screen lock off, the lock is one toggle", async () => {
    const ids = await expectCovered("workspace");
    expect(ids).toEqual([
      "workspace.index",
      "workspace.semantic",
      "workspace.embeddingModel",
      "workspace.excludedDirs",
      "workspace.reports",
      "workspace.metadata",
      "workspace.screenLock",
    ]);
  });

  test("with the screen lock on, its timeout, PIN and theme are entries too", async () => {
    lock = { ...lock, enabled: true };
    const ids = await expectCovered("workspace");
    expect(ids.slice(-4)).toEqual([
      "workspace.screenLock",
      "workspace.screenLock.timeout",
      "workspace.screenLock.pin",
      "workspace.screenLock.theme",
    ]);
  });

  test("with a PIN stored, the PIN entry and its button read Change PIN", async () => {
    lock = { enabled: true, timeout_secs: 300, theme: "plain", pin_set: true };
    await expectCovered("workspace");
    expect(settingEntry("workspace.screenLock.pin").label).toBe("Screen lock: Change PIN");
  });

  test("a binary without embeddings offers neither semantic search nor a model to pick", async () => {
    embeddings = false;
    const { target } = await openSettings("This workspace");
    await vi.waitFor(() => expect(text(target)).toContain("isn't compiled into this binary"));
    expect(offered("workspace")).not.toContain("workspace.semantic");
    expect(offered("workspace")).not.toContain("workspace.embeddingModel");
  });
});

describe("the fields the index leaves out", () => {
  test("are exactly the rendered fields without an entry, each with its reason", async () => {
    await expectCovered("graph", { ...settingsPreferences(), graph_colors: { mode: "custom" } });
    expect([...unanchored].sort()).toEqual(Object.keys(UNINDEXED_FIELDS).sort());
    for (const reason of Object.values(UNINDEXED_FIELDS)) expect(reason.length).toBeGreaterThan(0);
  });
});
