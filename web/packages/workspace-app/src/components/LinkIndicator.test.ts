// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ remote: true }));
vi.mock("../state/linkHealth.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/linkHealth.svelte")>()),
  linkIsRemote: () => host.remote,
}));

import LinkIndicator from "./LinkIndicator.svelte";
import { linkHealth, resetLinkHealthForTests } from "../state/linkHealth.svelte";
import { setCoverBlocking } from "../state/store.svelte";

let view: Record<string, unknown> | null = null;

beforeEach(() => {
  host.remote = true;
  resetLinkHealthForTests();
  setCoverBlocking("reconnect", false);
  setCoverBlocking("screensaver", false);
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
});

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  document.body.replaceChildren();
  resetLinkHealthForTests();
  setCoverBlocking("reconnect", false);
  setCoverBlocking("screensaver", false);
  vi.useRealTimers();
});

async function render(placement: "tab-bar" | "status" = "tab-bar") {
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(LinkIndicator, { target, props: { placement } }) as Record<string, unknown>;
  await tick();
  return target;
}

function button(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(".link-indicator");
}

function popover(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".link-popover");
}

function press(target: HTMLElement): MouseEvent {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  target.click();
  return down;
}

async function state(value: typeof linkHealth.state, rttMs: number | null = null, waitMs = 0): Promise<void> {
  linkHealth.state = value;
  linkHealth.rttMs = rttMs;
  linkHealth.waitMs = waitMs;
  await tick();
}

test("remote tab bar has quiet and dim unknown faces", async () => {
  await render();
  expect(button()?.getAttribute("data-state")).toBe("unknown");
  expect(button()?.getAttribute("aria-label")).toBe("Connection status unknown");
  expect(button()?.textContent?.trim()).toBe("");
  await state("ok");
  expect(button()?.getAttribute("data-state")).toBe("ok");
  expect(button()?.getAttribute("aria-label")).toBe("Connection healthy");
});

test("remote unhealthy faces show a label and accessible state", async () => {
  await render();
  await state("slow", 850);
  expect(button()?.textContent).toContain("850 ms");
  expect(button()?.title).toBe("Connection slow, 850 ms");
  await state("stalled", 850, 8_100);
  expect(button()?.textContent).toContain("stalled 8 s");
  expect(button()?.getAttribute("aria-label")).toBe("Connection stalled");
  await state("down");
  expect(button()?.textContent).toContain("reconnecting");
  expect(button()?.getAttribute("aria-label")).toBe("Connection reconnecting");
});

test.each(["tab-bar", "status"] as const)("%s recovering face keeps only the warning glyph and names recovery", async (placement) => {
  await state("slow", 26);
  await render(placement);
  expect(button()?.getAttribute("data-state")).toBe("slow");
  if (placement === "tab-bar") expect(button()?.querySelector(".label")?.textContent).toBe("");
  else expect(button()?.querySelector(".label")).toBeNull();
  expect(button()?.textContent?.trim()).toBe("");
  expect(button()?.title).toBe("Connection recovering");
  expect(button()?.getAttribute("aria-label")).toBe("Connection recovering");
});

test("local tab bar is absent while healthy or unknown and appears when slow", async () => {
  host.remote = false;
  await render();
  expect(button()).toBeNull();
  await state("ok");
  expect(button()).toBeNull();
  await state("slow", 450);
  expect(button()).not.toBeNull();
});

test("status placement only shows unhealthy states", async () => {
  await render("status");
  expect(button()).toBeNull();
  await state("slow", 500);
  expect(button()).not.toBeNull();
  await state("ok");
  expect(button()).toBeNull();
});

test("placement marks the tab-bar label for reserved width and leaves status natural", async () => {
  await state("down");
  await render("tab-bar");
  expect(button()?.dataset.placement).toBe("tab-bar");
  expect(button()?.classList.contains("status")).toBe(false);
  await unmount(view!);
  view = null;
  document.body.replaceChildren();
  await render("status");
  expect(button()?.dataset.placement).toBe("status");
  expect(button()?.classList.contains("status")).toBe(false);
});

test("only the tab-bar label reads its per-state reserved width", () => {
  // jsdom lays nothing out, so the tab-bar label's fixed width is a source contract.
  const source = readFileSync("src/components/LinkIndicator.svelte", "utf8");
  expect(source).toMatch(/\.link-indicator\[data-placement="tab-bar"\]\s+\.label\s*\{[^}]*\bmin-width:\s*var\(--link-indicator-label-width\);/);
  expect(source).not.toMatch(/\.link-indicator\[data-placement="status"\]\s+\.label\s*\{[^}]*\bmin-width:/);
});

test.each([
  ["slow", 850, 0, "7ch"],
  ["stalled", 850, 8_100, "12ch"],
  ["down", 850, 0, "12ch"],
] as const)("%s tab-bar label carries its state reserve", async (next, rtt, wait, width) => {
  await state(next, rtt, wait);
  await render();
  expect(button()?.querySelector(".label")).not.toBeNull();
  expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe(width);
});

test.each([
  ["unknown", null],
  ["ok", null],
] as const)("%s tab-bar face without a label carries no width reserve", async (next, rtt) => {
  await state(next, rtt);
  await render();
  expect(button()?.querySelector(".label")).toBeNull();
  expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe("");
});

test("recovering slow keeps an empty tab-bar label span and its 7ch reserve", async () => {
  await state("slow", 26);
  await render();
  expect(button()?.querySelector(".label")?.textContent).toBe("");
  expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe("7ch");
});

test("slow jitter around 300 ms changes the text without changing the tab-bar reserve", async () => {
  await render();
  for (const rtt of [299, 301, 298, 850]) {
    await state("slow", rtt);
    expect(button()?.querySelector(".label")?.textContent).toBe(rtt < 300 ? "" : `${rtt} ms`);
    expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe("7ch");
  }
});

test("status placement keeps natural label width in every unhealthy state", async () => {
  await render("status");
  for (const next of ["slow", "stalled", "down"] as const) {
    await state(next, 850, 8_100);
    expect(button()?.querySelector(".label")).not.toBeNull();
    expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe("");
  }
});

test("recovering status face drops its empty label span", async () => {
  await state("slow", 26);
  await render("status");
  expect(button()?.querySelector(".label")).toBeNull();
  expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe("");
});

test("counting within slow and stalled keeps each tab-bar reserve stable", async () => {
  await render();
  for (const [next, rtt, wait, width] of [
    ["slow", 850, 0, "7ch"],
    ["slow", 12_400, 0, "7ch"],
    ["stalled", 850, 9_100, "12ch"],
    ["stalled", 850, 10_100, "12ch"],
    ["stalled", 850, 44_100, "12ch"],
  ] as const) {
    await state(next, rtt, wait);
    expect(button()?.style.getPropertyValue("--link-indicator-label-width")).toBe(width);
  }
});

test("stalled label follows the health ticker's wait while closed", async () => {
  await render();
  await state("stalled", null, 8_100);
  expect(button()?.textContent).toContain("stalled 8 s");
  linkHealth.waitMs = 9_100;
  await tick();
  expect(button()?.textContent).toContain("stalled 9 s");
  expect(vi.getTimerCount()).toBe(0);
});

test("stalled popover age matches the face's unanswered wait", async () => {
  linkHealth.since = 16_000;
  await state("stalled", null, 8_100);
  await render();
  button()!.click();
  await tick();
  expect(button()?.textContent).toContain("stalled 8 s");
  expect(popover()?.textContent).toContain("No response for 8 s");
  linkHealth.waitMs = 9_100;
  await tick();
  expect(button()?.textContent).toContain("stalled 9 s");
  expect(popover()?.textContent).toContain("No response for 9 s");
});

test("a waiting slow ping has a stable accessible name that matches the face", async () => {
  await render();
  await state("slow", 80, 1_500);
  expect(button()?.textContent).toContain("1.5 s");
  expect(button()?.getAttribute("aria-label")).toBe("Connection slow, waiting for a reply");
  expect(button()?.title).toBe(button()?.getAttribute("aria-label"));
  linkHealth.waitMs = 2_500;
  await tick();
  expect(button()?.textContent).toContain("2.5 s");
  expect(button()?.getAttribute("aria-label")).toBe("Connection slow, waiting for a reply");
});

test("popover shows figures, samples, state age and last contact", async () => {
  linkHealth.samples = [{ at: 1, rttMs: 30 }, { at: 2, rttMs: null }, { at: 3, rttMs: 10 }];
  linkHealth.lastContactAt = 18_000;
  linkHealth.since = 8_000;
  await state("slow", 10);
  await render();
  button()!.click();
  await tick();
  expect(button()?.getAttribute("aria-expanded")).toBe("true");
  const pop = popover()!;
  expect(pop).not.toBeNull();
  expect(button()?.hasAttribute("aria-haspopup")).toBe(false);
  expect(button()?.getAttribute("aria-controls")).toBe(pop.id);
  expect(pop.textContent).toContain("Latest 10 ms");
  expect(pop.textContent).toContain("Median 20 ms");
  expect(pop.textContent).toContain("Worst 30 ms");
  const clock = new Date(18_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  expect(pop.querySelector(".contact strong")?.textContent).toBe(clock);
  expect(pop.textContent).toContain("Slow for 12 s");
  expect(pop.querySelectorAll(".miss")).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  await tick();
  expect(pop.textContent).toContain("Slow for 13 s");
});

test("an unknown link shows dashes for missing figures and contact", async () => {
  await render();
  button()!.click();
  await tick();
  expect(popover()?.textContent).toContain("No reading yet");
  for (const figure of ["Latest", "Median", "Worst", "Last contact"]) {
    expect(popover()?.textContent).toContain(`${figure} -`);
  }
});

test("opening later reads the state age while contact keeps its clock time", async () => {
  await state("slow", 500);
  linkHealth.since = 20_000;
  linkHealth.lastContactAt = 20_000;
  await render();
  vi.setSystemTime(25_000);
  button()!.click();
  await tick();
  expect.soft(popover()?.textContent).toContain("Slow for 5 s");
  const clock = new Date(20_000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  expect.soft(popover()?.querySelector(".contact strong")?.textContent).toBe(clock);
  vi.advanceTimersByTime(2_000);
  await tick();
  expect.soft(popover()?.textContent).toContain("Slow for 7 s");
  expect.soft(popover()?.querySelector(".contact strong")?.textContent).toBe(clock);
});

test("second press closes the popover", async () => {
  await render();
  press(button()!);
  await tick();
  press(button()!);
  await tick();
  expect(popover()).toBeNull();
  expect(button()?.getAttribute("aria-expanded")).toBe("false");
});

test("any full-window cover closes details and prevents reopening while keeping the face", async () => {
  await state("down");
  await render();
  button()!.click();
  await tick();
  expect(popover()).not.toBeNull();
  setCoverBlocking("screensaver", true);
  await tick();
  expect(popover()).toBeNull();
  expect(button()?.textContent).toContain("reconnecting");
  button()!.click();
  await tick();
  expect(popover()).toBeNull();
  setCoverBlocking("screensaver", false);
  await tick();
  button()!.click();
  await tick();
  expect(popover()).not.toBeNull();
});

test("blocked indicator announces its disabled state without losing its face colours", async () => {
  await state("down");
  await render();
  setCoverBlocking("reconnect", true);
  await tick();
  expect(button()?.getAttribute("aria-disabled")).toBe("true");
  expect(button()?.getAttribute("data-state")).toBe("down");
  const source = readFileSync("src/components/LinkIndicator.svelte", "utf8");
  expect(source).toMatch(/\.link-indicator\[aria-disabled="true"\]\s*\{\s*cursor:\s*default;/);
  expect(source).toMatch(/\.link-indicator:not\(\[aria-disabled="true"\]\):hover/);
});

test("a trigger press prevents focus leaving the terminal", async () => {
  const terminal = document.body.appendChild(document.createElement("button"));
  terminal.focus();
  await render();
  const triggerDown = press(button()!);
  await tick();
  expect(triggerDown.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(terminal);
});

test("a press inside the popover leaves it open and keeps terminal focus", async () => {
  const terminal = document.body.appendChild(document.createElement("button"));
  terminal.focus();
  await render();
  button()!.click();
  await tick();
  const popDown = press(popover()!);
  await tick();
  expect(popDown.defaultPrevented).toBe(true);
  expect(popover()).not.toBeNull();
  expect(document.activeElement).toBe(terminal);
});

test("hiding a local healthy face clears the popover's open state", async () => {
  host.remote = false;
  await state("slow", 600);
  await render();
  button()!.click();
  await tick();
  expect(popover()).not.toBeNull();
  await state("ok");
  expect(button()).toBeNull();
  expect(popover()).toBeNull();
  await state("slow", 600);
  expect(button()?.getAttribute("aria-expanded")).toBe("false");
  expect(popover()).toBeNull();
});

test("the age timer starts only while open and is released on close and unmount", async () => {
  await render();
  expect(vi.getTimerCount()).toBe(0);
  button()!.click();
  await tick();
  vi.advanceTimersByTime(100);
  await tick();
  expect(vi.getTimerCount()).toBe(1);
  button()!.click();
  await tick();
  vi.advanceTimersByTime(100);
  await tick();
  expect(vi.getTimerCount()).toBe(0);
  button()!.click();
  await tick();
  vi.advanceTimersByTime(100);
  await tick();
  expect(vi.getTimerCount()).toBe(1);
  await unmount(view!);
  view = null;
  vi.advanceTimersByTime(100);
  expect(vi.getTimerCount()).toBe(0);
  expect(popover()).toBeNull();
});

test("closing releases both window capture listeners", async () => {
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  try {
    await render();
    const beforeOpen = added.mock.calls.length;
    button()!.click();
    await tick();
    const opened = added.mock.calls.slice(beforeOpen);
    const mouse = opened.find(([type, , options]) => type === "mousedown" && options === true);
    const escape = opened.find(([type, , options]) => type === "keydown" && options === true);
    expect(mouse).toBeDefined();
    expect(escape).toBeDefined();

    button()!.click();
    await tick();
    expect.soft(removed).toHaveBeenCalledWith("mousedown", mouse![1], true);
    expect.soft(removed).toHaveBeenCalledWith("keydown", escape![1], true);

    const outside = document.body.appendChild(document.createElement("button"));
    const seen = vi.fn();
    outside.addEventListener("keydown", seen);
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    outside.dispatchEvent(key);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    outside.dispatchEvent(down);
    expect(key.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(seen).toHaveBeenCalledOnce();
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    added.mockRestore();
    removed.mockRestore();
  }
});

test("unmounting an open indicator removes its portaled popover", async () => {
  await render();
  button()!.click();
  await tick();
  expect(popover()).not.toBeNull();
  await unmount(view!);
  view = null;
  expect(popover()).toBeNull();
});

test("Escape closes before a focused outside surface receives it", async () => {
  await render();
  button()!.click();
  await tick();
  const outside = document.body.appendChild(document.createElement("button"));
  const seen = vi.fn();
  outside.addEventListener("keydown", seen);
  outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick();
  expect(seen).not.toHaveBeenCalled();
  expect(document.body.querySelector(".link-popover")).toBeNull();
});

test("Escape inside the details closes before the app's document handler", async () => {
  await render();
  button()!.click();
  await tick();
  const appEscape = vi.fn();
  document.addEventListener("keydown", appEscape);
  try {
    popover()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick();
    expect(appEscape).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  } finally {
    document.removeEventListener("keydown", appEscape);
  }
});

test("a press outside closes without moving focus", async () => {
  await render();
  button()!.click();
  await tick();
  const outside = document.body.appendChild(document.createElement("button"));
  outside.focus();
  outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await tick();
  expect(document.body.querySelector(".link-popover")).toBeNull();
  expect(document.activeElement).toBe(outside);
});

test("a stopped outside mousedown still closes in window capture", async () => {
  await render();
  button()!.click();
  await tick();
  const outside = document.body.appendChild(document.createElement("button"));
  outside.addEventListener("mousedown", (event) => event.stopPropagation());
  press(outside);
  await tick();
  expect(popover()).toBeNull();
});
