// @vitest-environment jsdom
//
// The screen lock as the user meets it: a modal cover over the window whose
// first input only wakes the unlock card. With a PIN set, the card takes the
// PIN and unlocks when the server verifies it, and a wrong one shakes the card
// and clears the field; with none set, the card says so and any further key or
// click unlocks.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import { api } from "../api/client";
import { demoWorkspaceInfo } from "../demo/data";
import { hashPin } from "../state/screensaver";
import { screensaver } from "../state/screensaver.svelte";
import { workspace } from "../state/store.svelte";
import { recordingContext2d } from "../__tests__/canvas";

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  // MatrixRain draws on a canvas and asks about reduced motion and fonts.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recordingContext2d().ctx as unknown as RenderingContext,
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn(async () => []) },
  });
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  Object.assign(screensaver, {
    enabled: true,
    timeout_secs: 300,
    theme: "plain",
    pin_set: true,
    locked: false,
    loaded: true,
  });
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  screensaver.locked = false;
  workspace.info = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(ScreensaverOverlay, { target }) as Record<string, unknown>);
  flushSync();
  await tick();
  return target;
}

async function lock(): Promise<HTMLElement> {
  screensaver.locked = true;
  flushSync();
  await tick();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop");
  expect(backdrop).not.toBeNull();
  return backdrop!;
}

function press(element: HTMLElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

describe("the screen lock", () => {
  test("shows nothing while unlocked", async () => {
    const target = await render();
    expect(target.querySelector(".screensaver-backdrop")).toBeNull();
  });

  test("covers the window as a focused modal dialog named Screen locked", async () => {
    await render();
    const backdrop = await lock();

    expect(backdrop.getAttribute("role")).toBe("dialog");
    expect(backdrop.getAttribute("aria-modal")).toBe("true");
    expect(backdrop.getAttribute("aria-label")).toBe("Screen locked");
    expect(document.activeElement).toBe(backdrop);
  });

  test("the first key only wakes the card, even with no PIN to ask for", async () => {
    screensaver.pin_set = false;
    await render();
    const backdrop = await lock();
    expect(backdrop.querySelector(".screensaver-card")).toBeNull();
    press(backdrop, "a");

    expect(backdrop.querySelector(".screensaver-card")).not.toBeNull();
    expect(screensaver.locked).toBe(true);
  });

  test("draws the Matrix rain for the matrix theme and the chan mark otherwise", async () => {
    await render();
    const plain = await lock();
    expect(plain.querySelector(".screensaver-mark")).not.toBeNull();
    expect(plain.querySelector("canvas.matrix-rain")).toBeNull();

    screensaver.theme = "matrix";
    flushSync();
    expect(plain.querySelector(".screensaver-mark")).toBeNull();
    expect(plain.querySelector("canvas.matrix-rain")).not.toBeNull();
  });
});

describe("with a PIN set", () => {
  test("the card takes the PIN, focused, and unlocks when the server verifies it", async () => {
    const verify = vi.spyOn(api, "screensaverVerify").mockResolvedValue({ verified: true });
    await render();
    const backdrop = await lock();
    press(backdrop, "a");
    await tick();
    const input = backdrop.querySelector<HTMLInputElement>("input.screensaver-pin");
    expect(input?.type).toBe("password");
    expect(document.activeElement).toBe(input);

    input!.value = "1234";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    press(input!, "Enter");

    // The PIN hash is a PBKDF2 derivation in WebCrypto's worker pool, whose
    // time grows with the machine's load, so the wait is bounded generously.
    await vi.waitFor(() => expect(screensaver.locked).toBe(false), { timeout: 10_000 });
    expect(verify).toHaveBeenCalledWith(await hashPin("1234", "/ws"));
    flushSync();
    expect(document.querySelector(".screensaver-backdrop")).toBeNull();
  });

  test("a wrong PIN shakes the card, clears the field and stays locked", async () => {
    vi.spyOn(api, "screensaverVerify").mockResolvedValue({ verified: false });
    await render();
    const backdrop = await lock();
    press(backdrop, "a");
    const input = backdrop.querySelector<HTMLInputElement>("input.screensaver-pin")!;
    input.value = "9999";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.useFakeTimers();
    press(input, "Enter");

    await vi.waitFor(
      () => expect(backdrop.querySelector(".screensaver-card")?.classList.contains("shake")).toBe(true),
      { timeout: 10_000 },
    );
    expect(input.value).toBe("");
    expect(backdrop.querySelector('[role="alert"]')?.textContent).toBe("Wrong PIN");
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    expect(backdrop.querySelector(".screensaver-card")?.classList.contains("shake")).toBe(false);
    expect(screensaver.locked).toBe(true);
  });

  test("keys and clicks on the cover do not unlock", async () => {
    await render();
    const backdrop = await lock();
    press(backdrop, "a");
    press(backdrop, "b");
    backdrop.click();
    flushSync();

    expect(screensaver.locked).toBe(true);
  });
});

describe("with no PIN set", () => {
  beforeEach(() => {
    screensaver.pin_set = false;
  });

  test("the card says any input unlocks and asks for no PIN", async () => {
    await render();
    const backdrop = await lock();
    press(backdrop, "a");

    const card = backdrop.querySelector(".screensaver-card")!;
    expect(card.textContent?.replace(/\s+/g, " ")).toContain(
      "No PIN set on this workspace. Press any key or click to unlock.",
    );
    expect(card.querySelector("input")).toBeNull();
  });

  test("the next key unlocks", async () => {
    await render();
    const backdrop = await lock();
    press(backdrop, "a");
    press(backdrop, "b");

    expect(screensaver.locked).toBe(false);
  });

  test("a click wakes, the next click unlocks", async () => {
    await render();
    const backdrop = await lock();
    backdrop.click();
    flushSync();
    expect(screensaver.locked).toBe(true);
    backdrop.click();
    flushSync();

    expect(screensaver.locked).toBe(false);
  });
});
