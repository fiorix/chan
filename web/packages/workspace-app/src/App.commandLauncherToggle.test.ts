// @vitest-environment jsdom
//
// The command launcher's chord toggles: a second press closes the open
// launcher, wherever the keyboard is inside it. The open launcher takes every
// key ahead of the app's own listener, so it is told which key the chord is,
// the built-in one or one the user assigned.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { hydrateOverrides } from "./state/keymapOverrides.svelte";
import { launcherDraft, launcherPanel } from "./state/store.svelte";

stubAppEnvironment();

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
const CHORD: KeyboardEventInit = { key: "k", code: "KeyK", ctrlKey: true, altKey: true };

/// Press a key with the keyboard on the launcher's query, as a user typing
/// in the open launcher does.
async function pressInLauncher(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const query = document.querySelector(".deck-input");
  expect(query, "the launcher's query").not.toBeNull();
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  query!.dispatchEvent(event);
  await settle();
  return event;
}

beforeEach(async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX_UA);
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  launcherPanel.open = false;
});

afterEach(async () => {
  hydrateOverrides(null);
  launcherPanel.open = false;
  await unmountApp();
  vi.restoreAllMocks();
});

describe("the command launcher chord", () => {
  test("closes the open launcher from its query, and opens it again", async () => {
    press(CHORD);
    await settle();
    expect(launcherPanel.open).toBe(true);

    const second = await pressInLauncher(CHORD);
    expect(launcherPanel.open, "the chord toggles").toBe(false);
    expect(second.defaultPrevented).toBe(true);

    press(CHORD);
    await settle();
    expect(launcherPanel.open).toBe(true);
  });

  test("closes the open launcher when the key reaches the page", async () => {
    press(CHORD);
    await settle();
    expect(launcherPanel.open).toBe(true);
    press(CHORD);
    await settle();
    expect(launcherPanel.open).toBe(false);
  });

  test("keeps what was typed, as any dismissal does", async () => {
    press(CHORD);
    await settle();
    const query = document.querySelector(".deck-input") as HTMLInputElement;
    query.value = "split";
    query.dispatchEvent(new InputEvent("input", { bubbles: true, data: "split" }));
    await settle();
    await pressInLauncher(CHORD);
    expect(launcherPanel.open).toBe(false);
    expect(launcherDraft.query).toBe("split");
  });

  test("a chord the user assigned to the launcher toggles it too", async () => {
    // This page is a browser's, so the assignment it reads is the web one.
    hydrateOverrides({ "app.launcher.toggle": { web: "Ctrl+Alt+Y" } });
    const assigned: KeyboardEventInit = { key: "y", code: "KeyY", ctrlKey: true, altKey: true };
    press(assigned);
    await settle();
    expect(launcherPanel.open).toBe(true);
    await pressInLauncher(assigned);
    expect(launcherPanel.open).toBe(false);
  });

  test("the open launcher still keeps every other key from the app", async () => {
    press(CHORD);
    await settle();
    // Ctrl+Alt+S is the app's search chord.
    const search = await pressInLauncher({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    expect(launcherPanel.open).toBe(true);
    expect(search.defaultPrevented, "the app's listener never saw it").toBe(false);
    expect(document.querySelector(".deck-input"), "the launcher is still what is open").not.toBeNull();
  });
});
