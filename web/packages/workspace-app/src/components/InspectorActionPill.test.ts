// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import InspectorActionPill from "./InspectorActionPill.svelte";
import {
  allCommands,
  commandById,
  registerCommands,
  unregisterCommands,
  type Command,
} from "../state/commands";

const MAIN = "app.editor.showInBrowser";
const SECONDARY = ["app.editor.download", "app.editor.exportPdf"];

const mounted: Array<Record<string, unknown>> = [];
let catalog: Command[] | null = null;

async function render(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(InspectorActionPill, {
    target,
    props: {
      main: { command: MAIN, onClick: vi.fn() },
      secondary: [
        { command: SECONDARY[0]!, onClick: vi.fn() },
        { command: SECONDARY[1]!, onClick: vi.fn(), disabled: true, title: "Unavailable" },
      ],
    },
  }));
  await tick();
  return target;
}

async function openMenu(target: HTMLElement): Promise<void> {
  target.querySelector<HTMLButtonElement>(".pill-caret")!.click();
  flushSync();
  await tick();
  expect(target.querySelector(".action-menu")).not.toBeNull();
}

/// The pill's words, the primary action first.
function labels(target: HTMLElement): string[] {
  return [
    target.querySelector(".pill-main")?.textContent?.trim() ?? "",
    ...[...target.querySelectorAll(".action-menu-item")].map((el) => el.textContent?.trim() ?? ""),
  ];
}

function title(id: string): string {
  const command = commandById(id);
  if (!command) throw new Error(`no command ${id}`);
  return command.title;
}

/// Registers every command again under a title that spells its id, so an
/// action worded by the registry shows the id and typed words do not.
function retitleCatalog(): void {
  catalog = allCommands();
  unregisterCommands(() => true);
  registerCommands(catalog.map((command) => ({ ...command, title: `<${command.id}>` })));
}

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  if (catalog) {
    unregisterCommands(() => true);
    registerCommands(catalog);
    catalog = null;
  }
});

test("words each action by the title of its command", async () => {
  const target = await render();
  await openMenu(target);

  expect(labels(target)).toEqual([MAIN, ...SECONDARY].map(title));
});

test("follows the registry when a command's title changes", async () => {
  retitleCatalog();
  const target = await render();
  await openMenu(target);

  expect(labels(target)).toEqual([MAIN, ...SECONDARY].map((id) => `<${id}>`));
});

test("takes Escape before the focused surface can stop it", async () => {
  const target = await render();
  await openMenu(target);
  const under = document.createElement("button");
  document.body.append(under);
  const seen = vi.fn((event: KeyboardEvent) => event.stopPropagation());
  under.addEventListener("keydown", seen);
  under.focus();

  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  under.dispatchEvent(event);
  flushSync();

  expect(target.querySelector(".action-menu")).toBeNull();
  expect(target.querySelector(".pill-caret")?.getAttribute("aria-expanded")).toBe("false");
  expect(seen).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(under);
  expect(event.defaultPrevented).toBe(true);
});

test("closes when Escape starts on a focused menu item", async () => {
  const target = await render();
  await openMenu(target);
  const item = target.querySelector<HTMLButtonElement>(".action-menu-item")!;
  const seen = vi.fn();
  item.addEventListener("keydown", seen);
  item.focus();

  item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  flushSync();

  expect(seen).toHaveBeenCalledTimes(1);
  expect(target.querySelector(".action-menu")).toBeNull();
});

test("passes Escape to the focused surface when closed", async () => {
  await render();
  const under = document.createElement("button");
  document.body.append(under);
  const seen = vi.fn();
  under.addEventListener("keydown", seen);
  under.focus();

  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  under.dispatchEvent(event);

  expect(seen).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(under);
  expect(event.defaultPrevented).toBe(false);
});
