// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import InspectorActionPill from "./InspectorActionPill.svelte";

const mounted: Array<Record<string, unknown>> = [];

async function render(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(InspectorActionPill, {
    target,
    props: {
      main: { label: "Open", onClick: vi.fn() },
      secondary: [
        { label: "Reveal", onClick: vi.fn() },
        { label: "Download", onClick: vi.fn(), disabled: true, title: "Unavailable" },
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

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
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
