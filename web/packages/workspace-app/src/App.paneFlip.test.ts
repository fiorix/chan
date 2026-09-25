// @vitest-environment jsdom
//
// The pane flip turns the focused pane to its other side. It is a command of
// its own, reached from the host as `app.pane.flip` (and the older
// `app.settings.toggle` id) or with Ctrl+`, and never from the comma, which
// opens Settings. It refuses while anything renders over the panes: flipping
// there would turn a pane the user cannot see, and closing the surface would
// reveal it silently turned.

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { uiConfirm, resolveConfirm } from "./state/confirm.svelte";
import { paneModalGuard } from "./state/paneModalGuard.svelte";
import {
  importContactsPanel,
  resolvePathPrompt,
  resolvePrompt,
  settingsPanel,
  uiPathPrompt,
  uiPrompt,
  workspaceWarningsDialog,
} from "./state/store.svelte";
import { teamDialogState } from "./state/teamDialog.svelte";
import { conflictDialog, draftCloseState, layout, type LeafNode } from "./state/tabs.svelte";

stubAppEnvironment();

const PANE = "pane-test";

function side(): string | undefined {
  return (layout.nodes[PANE] as LeafNode | undefined)?.side ?? "a";
}

beforeEach(async () => {
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
});

afterEach(async () => {
  settingsPanel.open = false;
  await unmountApp();
});

describe("the pane flip", () => {
  test("the flip command turns the focused pane over and back", async () => {
    hostCommand("app.pane.flip");
    await settle();
    expect(side()).toBe("b");
    hostCommand("app.pane.flip");
    await settle();
    expect(side()).toBe("a");
  });

  test("the older settings-toggle id flips the pane and opens nothing", async () => {
    hostCommand("app.settings.toggle");
    await settle();

    expect(side()).toBe("b");
    expect(settingsPanel.open).toBe(false);
  });

  test("Ctrl+` flips the pane", async () => {
    press({ key: "`", code: "Backquote", ctrlKey: true });
    await settle();
    expect(side()).toBe("b");
  });

  test("Ctrl+, opens Settings and leaves the pane alone", async () => {
    press({ key: ",", code: "Comma", ctrlKey: true });
    await settle();

    expect(settingsPanel.open).toBe(true);
    expect(side()).toBe("a");
  });
});

describe("the pane flip refuses while something covers the panes", () => {
  const blockers: Array<[string, () => void, () => void]> = [
    ["an open overlay", () => (settingsPanel.open = true), () => (settingsPanel.open = false)],
    ["a prompt", () => void uiPrompt("Name?"), () => resolvePrompt(null)],
    [
      "a path prompt",
      () => void uiPathPrompt({ title: "Path", kind: "file", mode: "create" }),
      () => resolvePathPrompt(null),
    ],
    ["a confirmation", () => void uiConfirm({ title: "Sure?", message: "Really?" }), () => resolveConfirm(false)],
    ["the draft close dialog", () => (draftCloseState.open = true), () => (draftCloseState.open = false)],
    [
      "the Team Work dialog",
      () => (teamDialogState.request = { leadTabId: "a-file", leadPaneId: PANE }),
      () => (teamDialogState.request = null),
    ],
    ["the file conflict dialog", () => (conflictDialog.open = true), () => (conflictDialog.open = false)],
    [
      "the workspace warnings",
      () => (workspaceWarningsDialog.open = true),
      () => (workspaceWarningsDialog.open = false),
    ],
    ["the contacts import", () => (importContactsPanel.open = true), () => (importContactsPanel.open = false)],
    ["a pane's own modal", () => (paneModalGuard.openCount = 1), () => (paneModalGuard.openCount = 0)],
  ];

  test.each(blockers)("%s", async (_name, open, close) => {
    open();
    flushSync();
    await settle();
    hostCommand("app.pane.flip");
    hostCommand("app.settings.toggle");
    press({ key: "`", code: "Backquote", ctrlKey: true });
    await settle();
    expect(side()).toBe("a");

    close();
    await settle();
    hostCommand("app.pane.flip");
    await settle();
    expect(side()).toBe("b");
  });
});

