// @vitest-environment jsdom
//
// Settings > This workspace > Screen lock: the toggle, and while it is on the
// inactivity timeout, the PIN controls, the theme picker with its preview and
// a Test button. Every change is written through /api/screensaver and then
// reloaded into the lock itself, so the running lock follows the settings.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ScreenLockControl from "./ScreenLockControl.svelte";
import NumberField from "../NumberField.svelte";
import { api } from "../../../api/client";
import { demoWorkspaceInfo } from "../../../demo/data";
import {
  hashPin,
  SCREENSAVER_MAX_TIMEOUT_SECS,
  SCREENSAVER_MIN_TIMEOUT_SECS,
  type ScreensaverTheme,
} from "../../../state/screensaver";
import { screensaver } from "../../../state/screensaver.svelte";
import { workspace } from "../../../state/store.svelte";
import { recordingContext2d } from "../../../__tests__/canvas";

type LockState = {
  enabled: boolean;
  timeout_secs: number;
  theme: ScreensaverTheme;
  pin_set: boolean;
};

let server: LockState;
const mounted: Array<() => void> = [];

beforeEach(() => {
  server = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: false };
  vi.spyOn(api, "screensaverState").mockImplementation(async () => ({ ...server }));
  vi.spyOn(api, "screensaverPatch").mockImplementation(async (body) => {
    server = { ...server, ...body };
    return { ...server };
  });
  vi.spyOn(api, "screensaverSetPin").mockImplementation(async () => {
    server = { ...server, pin_set: true };
    return { ...server };
  });
  vi.spyOn(api, "screensaverClearPin").mockImplementation(async () => {
    server = { ...server, pin_set: false };
    return { ...server };
  });
  // The previews draw on a canvas.
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
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  Object.assign(screensaver, {
    enabled: false,
    timeout_secs: 300,
    theme: "plain",
    pin_set: false,
    locked: false,
    loaded: false,
  });
});

afterEach(() => {
  for (const stop of mounted.splice(0)) stop();
  document.body.innerHTML = "";
  screensaver.locked = false;
  workspace.info = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

async function render(state: Partial<LockState> = {}): Promise<HTMLElement> {
  server = { ...server, ...state };
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(ScreenLockControl, { target });
  mounted.push(() => unmount(instance));
  await settle();
  return target;
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(found, `a "${label}" button`).toBeDefined();
  return found!;
}

function alertText(target: HTMLElement): string | null {
  return target.querySelector('[role="alert"]')?.textContent ?? null;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Screen lock toggle", () => {
  test("shows the stored state and hides the settings while the lock is off", async () => {
    const target = await render();

    expect(target.textContent).toContain("Screen lock");
    expect(target.querySelector("label.pill")?.textContent?.trim()).toBe("Off");
    expect(target.querySelector('[aria-label="Inactivity timeout in seconds"]')).toBeNull();
    expect(target.querySelector("select")).toBeNull();
  });

  test("turning it on writes the change and loads it into the running lock", async () => {
    const target = await render();
    const toggle = target.querySelector<HTMLInputElement>('label.pill input[type="checkbox"]');
    expect(toggle?.checked).toBe(false);
    toggle!.click();
    await settle();

    expect(api.screensaverPatch).toHaveBeenCalledWith({ enabled: true });
    expect(screensaver.enabled).toBe(true);
    expect(target.querySelector('[aria-label="Inactivity timeout in seconds"]')).not.toBeNull();
  });
});

describe("with the lock on", () => {
  test("a timeout is written and loaded into the running lock", async () => {
    const target = await render({ enabled: true });
    const field = target.querySelector<HTMLInputElement>('[aria-label="Inactivity timeout in seconds"]')!;
    type(field, "600");
    field.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await settle();

    expect(api.screensaverPatch).toHaveBeenCalledWith({ timeout_secs: 600 });
    expect(screensaver.timeout_secs).toBe(600);
    expect(alertText(target)).toBeNull();
  });

  test("an entry below the minimum is written as the minimum, with a warning", async () => {
    const target = await render({ enabled: true });
    const field = target.querySelector<HTMLInputElement>('[aria-label="Inactivity timeout in seconds"]')!;
    type(field, "3");
    field.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await settle();

    expect(api.screensaverPatch).toHaveBeenCalledWith({ timeout_secs: SCREENSAVER_MIN_TIMEOUT_SECS });
    expect(alertText(target)).toBe(`Timeout must be at least ${SCREENSAVER_MIN_TIMEOUT_SECS}s`);
  });

  test("an entry above the stored maximum warns without writing it again", async () => {
    const target = await render({ enabled: true, timeout_secs: SCREENSAVER_MAX_TIMEOUT_SECS });
    const field = target.querySelector<HTMLInputElement>('[aria-label="Inactivity timeout in seconds"]')!;
    type(field, String(SCREENSAVER_MAX_TIMEOUT_SECS * 2));
    field.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await settle();

    expect(api.screensaverPatch).not.toHaveBeenCalled();
    expect(alertText(target)).toBe(`Timeout must be at most ${SCREENSAVER_MAX_TIMEOUT_SECS}s`);
  });

  test("the theme picker offers Default and Matrix, writes the choice and previews it", async () => {
    const target = await render({ enabled: true });
    const select = target.querySelector("select")!;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["plain", "Default"],
      ["matrix", "Matrix"],
    ]);
    expect(target.querySelector(".preview-box canvas")).toBeNull();

    select.value = "matrix";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(api.screensaverPatch).toHaveBeenCalledWith({ theme: "matrix" });
    expect(screensaver.theme).toBe("matrix");
    expect(target.querySelector(".preview-box canvas")).not.toBeNull();
  });

  test("previews the chosen theme inside the lock's settings, and names it", async () => {
    const target = await render({ enabled: true, theme: "plain" });
    const preview = target.querySelector(".screensaver-preview")!;
    expect(preview.querySelector(".preview-title")?.textContent).toBe("Screensaver preview");
    expect(preview.querySelector(".preview-box .plain-screensaver-preview .mark")).not.toBeNull();
    expect(preview.querySelector(".hint")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Preview of the Default lock theme.",
    );

    const select = target.querySelector("select")!;
    select.value = "matrix";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(target.querySelector(".screensaver-preview .hint")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Preview of the Matrix lock theme.",
    );
  });

  test("Set PIN asks twice, refuses a mismatch and saves the workspace-salted hash", async () => {
    const target = await render({ enabled: true });
    button(target, "Set PIN").click();
    flushSync();
    const [pin, confirm] = [...target.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    type(pin!, "1234");
    type(confirm!, "1235");
    button(target, "Save").click();
    await settle();
    expect(alertText(target)).toBe("PINs don't match");
    expect(api.screensaverSetPin).not.toHaveBeenCalled();

    type(confirm!, "1234");
    button(target, "Save").click();
    // The PIN hash is a PBKDF2 derivation in WebCrypto's worker pool, whose
    // time grows with the machine's load, so wait for the save itself.
    await vi.waitFor(() => expect(api.screensaverSetPin).toHaveBeenCalled(), { timeout: 10_000 });
    await settle();

    expect(api.screensaverSetPin).toHaveBeenCalledWith(await hashPin("1234", "/ws"));
    expect(screensaver.pin_set).toBe(true);
    expect(target.querySelector('input[type="password"]')).toBeNull();
    button(target, "Change PIN");
  });

  test("Clear PIN clears it and loads the change into the running lock", async () => {
    const target = await render({ enabled: true, pin_set: true });
    screensaver.pin_set = true;
    button(target, "Clear PIN").click();
    await settle();

    expect(api.screensaverClearPin).toHaveBeenCalledTimes(1);
    expect(screensaver.pin_set).toBe(false);
    button(target, "Set PIN");
  });

  test("Test loads the settings and locks at once", async () => {
    const target = await render({ enabled: true });
    button(target, "Test").click();
    await settle();

    expect(screensaver.locked).toBe(true);
  });

  test("Test reports a lock it cannot load instead of locking", async () => {
    const target = await render({ enabled: true });
    vi.mocked(api.screensaverState).mockRejectedValue(new Error("offline"));
    button(target, "Test").click();
    await settle();

    expect(screensaver.locked).toBe(false);
    expect(alertText(target)).toBe("screen lock state unavailable");
  });
});

// The timeout field mounted with the screensaver bounds. The commit contract
// the timeout relies on: an out-of-range entry clamps back onto the stored
// bound yet still fires with the bound named, so the control can show its
// warning and skip the write itself.
describe("NumberField timeout clamp at the stored bound", () => {
  let target: HTMLDivElement;
  let cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    target?.remove();
  });

  function mountTimeoutField(value: number): [number | null, string | null][] {
    const commits: [number | null, string | null][] = [];
    target = document.createElement("div");
    document.body.appendChild(target);
    const cmp = mount(NumberField, {
      target,
      props: {
        value,
        min: SCREENSAVER_MIN_TIMEOUT_SECS,
        max: SCREENSAVER_MAX_TIMEOUT_SECS,
        ariaLabel: "Inactivity timeout in seconds",
        oncommit: (v: number | null, c: string | null) => commits.push([v, c]),
      },
    });
    cleanups.push(() => unmount(cmp));
    return commits;
  }

  function enterAndBlur(text: string): HTMLInputElement {
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    return input;
  }

  test("out-of-range entry with the stored value at the min still reports the clamp", async () => {
    const commits = mountTimeoutField(SCREENSAVER_MIN_TIMEOUT_SECS);
    await tick();
    enterAndBlur(String(SCREENSAVER_MIN_TIMEOUT_SECS - 5));
    await tick();
    expect(commits).toEqual([[SCREENSAVER_MIN_TIMEOUT_SECS, "min"]]);
  });

  test("cleared field with the stored value at the min still reports the clamp", async () => {
    // Not nullable and no invalidFallback: empty text falls back onto
    // the min bound and is reported as a min clamp.
    const commits = mountTimeoutField(SCREENSAVER_MIN_TIMEOUT_SECS);
    await tick();
    enterAndBlur("");
    await tick();
    expect(commits).toEqual([[SCREENSAVER_MIN_TIMEOUT_SECS, "min"]]);
  });

  test("re-entering the stored in-range value commits nothing", async () => {
    const commits = mountTimeoutField(300);
    await tick();
    enterAndBlur("300");
    await tick();
    expect(commits).toEqual([]);
  });
});
