// @vitest-environment jsdom
//
// The extension tab's menu: Reload extension and, for an extension that
// presents, Present extension as a check, then the tail every tab menu ends
// with (Flip pane, which turns the tab's own pane, and Close tab) and the
// launcher row. Each row is worded by the catalog, and each of the tab's two
// commands runs the function its row runs: the launcher's Present extension
// and the row flip one state, and its Reload extension loads the frame the
// row reloads.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { expectWords } from "../__tests__/menuWords";
import { resetLayout } from "../__tests__/tabs";
import { api } from "../api/client";
import type { ExtensionInfo } from "../api/types";
import { commandById, commandContext, commandState, commandUnavailableReason } from "../state/commands";
import { extensionPresenting, refreshExtensions } from "../state/extensions.svelte";
import { launcherPanel } from "../state/store.svelte";
import {
  activePane,
  layout,
  paneSide,
  splitPane,
  type ExtensionTab as ExtensionTabState,
  type LeafNode,
} from "../state/tabs.svelte";
import ExtensionTab from "./ExtensionTab.svelte";

const ENTRY: ExtensionInfo = {
  id: "echo",
  name: "Echo",
  entry_path: `/_chan/extensions/echo/${"a".repeat(64)}/`,
  singleton: true,
  running: true,
  capabilities: ["presentation"],
};

let view: Record<string, unknown> | null = null;
let target: HTMLElement;
let tab: ExtensionTabState;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/// Offer `entry` as the catalog's one extension, open its tab in the focused
/// pane and mount it.
async function show(entry: ExtensionInfo): Promise<void> {
  resetLayout([]);
  vi.spyOn(api, "extensions").mockResolvedValue([entry]);
  await refreshExtensions();
  commandById("extension.echo")!.run();
  const opened = activePane().tabs[0];
  if (opened?.kind !== "extension") throw new Error("expected an extension tab");
  tab = opened;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ExtensionTab, { target, props: { tab, paneId: activePane().id } });
  flushSync();
}

beforeEach(() => {
  globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame ??= ((handle: number) =>
    window.clearTimeout(handle)) as typeof cancelAnimationFrame;
});

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  document.body.innerHTML = "";
  launcherPanel.open = false;
  vi.spyOn(api, "extensions").mockResolvedValue([]);
  await refreshExtensions();
  vi.restoreAllMocks();
});

async function openMenu(): Promise<HTMLButtonElement[]> {
  target
    .querySelector(".extension-tab")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await flush();
  return [...document.body.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")];
}

function label(button: HTMLButtonElement): string {
  return button.querySelector(".menu-row-label")?.textContent?.trim() ?? "";
}

async function row(name: string): Promise<HTMLButtonElement> {
  const found = (await openMenu()).find((button) => label(button) === name);
  if (!found) throw new Error(`no menu row ${name}`);
  return found;
}

describe("the extension tab's menu", () => {
  test("words every row by the catalog", async () => {
    await show(ENTRY);

    expectWords((await openMenu()).map(label), [
      { command: "app.extension.reload" },
      { command: "app.extension.present" },
      { command: "app.pane.flip" },
      { command: "app.tab.close" },
      { shortcut: "app.launcher.toggle" },
    ]);
  });

  test("offers no Present extension for an extension that does not present", async () => {
    await show({ ...ENTRY, capabilities: [] });

    expectWords((await openMenu()).map(label), [
      { command: "app.extension.reload" },
      { command: "app.pane.flip" },
      { command: "app.tab.close" },
      { shortcut: "app.launcher.toggle" },
    ]);
    expect(commandById("app.extension.present")!.available(commandContext())).toBe(false);
    expect(commandUnavailableReason(commandById("app.extension.present")!, commandContext())).toBe(
      "The extension does not present",
    );
  });

  test("Present extension is a check: the row presents the tab and the command reports it", async () => {
    await show(ENTRY);
    let present = await row("Present extension");
    expect(present.getAttribute("role")).toBe("menuitemcheckbox");
    expect(present.getAttribute("aria-checked")).toBe("false");
    expect(commandState("app.extension.present")).toBe(false);

    present.click();
    await flush();
    expect(target.querySelector(".extension-tab")!.classList.contains("presenting")).toBe(true);
    expect(commandState("app.extension.present")).toBe(true);

    // A presented frame covers the launcher, so its row is left out.
    const rows = await openMenu();
    present = rows.find((button) => label(button) === "Present extension")!;
    expect(present.getAttribute("aria-checked")).toBe("true");
    expect(rows.map(label)).not.toContain("Command launcher");

    present.click();
    await flush();
    expect(target.querySelector(".extension-tab")!.classList.contains("presenting")).toBe(false);
  });

  test("the launcher's Present extension presents the focused tab, and leaves once it does", async () => {
    await show(ENTRY);
    launcherPanel.open = true;

    commandById("app.extension.present")!.run();
    await flush();

    expect(extensionPresenting(tab.id)).toBe(true);
    expect(target.querySelector(".extension-tab")!.classList.contains("presenting")).toBe(true);
    expect(launcherPanel.open, "the presented frame would cover the launcher").toBe(false);
    expect((await row("Present extension")).getAttribute("aria-checked")).toBe("true");
  });

  test("the presentation bar's Close is the Close tab command's word", async () => {
    await show(ENTRY);
    (await row("Present extension")).click();
    await flush();

    const [restore, close] = [
      ...target.querySelectorAll<HTMLButtonElement>(".presentation-chrome button"),
    ];
    expect(restore!.textContent?.trim(), "the bar's own way out").toBe("Restore");
    expectWords([close!.getAttribute("aria-label")!, close!.textContent!.trim()], [
      { command: "app.tab.close" },
      { command: "app.tab.close" },
    ]);

    close!.click();
    await flush();
    expect(activePane().tabs).toEqual([]);
    expect(extensionPresenting(tab.id), "a closed tab presents nothing").toBe(false);
  });

  test("the launcher's Reload extension reloads the focused tab's frame, as the row does", async () => {
    await show(ENTRY);
    expect(target.querySelector("iframe")).not.toBeNull();

    // The extension's process exits; a reload finds that out.
    const extensions = vi.spyOn(api, "extensions");
    extensions.mockClear().mockResolvedValue([{ ...ENTRY, running: false }]);
    commandById("app.extension.reload")!.run();
    await flush();
    expect(extensions).toHaveBeenCalledTimes(1);
    expect(target.querySelector("iframe")).toBeNull();
    expect(target.textContent).toContain("Its process exited.");

    // It runs again; the row brings the frame back.
    extensions.mockResolvedValue([ENTRY]);
    (await row("Reload extension")).click();
    await flush();
    expect(target.querySelector("iframe")).not.toBeNull();
  });

  test("Reload extension is not offered for an extension the catalog lost", async () => {
    await show(ENTRY);
    vi.spyOn(api, "extensions").mockResolvedValue([]);
    await refreshExtensions();
    flushSync();

    expect((await row("Reload extension")).disabled).toBe(true);
    const reload = commandById("app.extension.reload")!;
    expect(reload.available(commandContext())).toBe(false);
    expect(commandUnavailableReason(reload, commandContext())).toBe("The extension is unavailable");
  });

  test("Flip pane turns the pane to its other side and Close tab closes the tab", async () => {
    await show(ENTRY);
    (await row("Flip pane")).click();
    await flush();
    expect(paneSide(activePane())).toBe("b");

    (await row("Flip pane")).click();
    await flush();
    (await row("Close tab")).click();
    await flush();
    expect(activePane().tabs).toEqual([]);
  });

  test("Flip pane turns the tab's own pane while another pane holds the focus", async () => {
    await show(ENTRY);
    const own = activePane().id;
    const other = splitPane(own, "row")!;
    expect(activePane().id, "the new pane holds the focus").toBe(other);

    (await row("Flip pane")).click();
    await flush();

    expect(paneSide(layout.nodes[own] as LeafNode), "the tab's pane").toBe("b");
    expect(paneSide(activePane()), "the focused pane").toBe("a");
  });

  test("Command launcher opens the launcher's bus and closes the menu", async () => {
    await show(ENTRY);
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<{ name: string }>).detail.name);
    window.addEventListener("chan:command", listen);
    try {
      (await row("Command launcher")).click();
      await flush();
    } finally {
      window.removeEventListener("chan:command", listen);
    }

    expect(seen).toEqual(["app.launcher.toggle"]);
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });
});
