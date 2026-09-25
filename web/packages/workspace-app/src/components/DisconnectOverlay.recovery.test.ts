// @vitest-environment jsdom
//
// Once the connection to the chan server has been up and then drops, the
// overlay covers the window after a short grace: a spinner, what it is doing,
// and a retry readout of the reconnect attempt and the time elapsed. On a
// desktop window backed by a devserver it also offers Reconnect (the desktop
// force-closes the dead control terminal and dials again) and Abandon, each
// showing it is busy and saying why when the desktop refuses. A browser, or a
// desktop window on the local library, gets no actions: the watcher keeps
// retrying on its own.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { abandonDevserverForWindow, reconnectDevserverForWindow } from "../api/desktop";
import { ui } from "../state/store.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

let invoke: ReturnType<typeof vi.fn<(cmd: string) => Promise<unknown>>>;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn(async () => undefined);
  ui.ws = "open";
  ui.wsAttempt = 0;
});

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  document.body.innerHTML = "";
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
});

function desktopWindow(lib: string): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  history.replaceState(null, "", `/?lib=${lib}`);
}

async function dropConnection(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(DisconnectOverlay, { target }));
  await tick();
  ui.ws = "reconnecting";
  await tick();
  vi.advanceTimersByTime(600);
  await tick();
  expect(target.querySelector(".overlay")).not.toBeNull();
  return target;
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  return [...target.querySelectorAll<HTMLButtonElement>(".actions button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
}

describe("the reconnect overlay", () => {
  test("shows a spinner, what it is doing, and the attempt with the time elapsed", async () => {
    ui.wsAttempt = 3;
    const target = await dropConnection();

    expect(target.querySelector(".spinner")).not.toBeNull();
    expect(target.querySelector(".title")?.textContent).toBe("reconnecting to the chan server");
    expect(target.querySelector(".meta")?.textContent).toBe("attempt 3 · 00:00");

    vi.advanceTimersByTime(65_000);
    await tick();
    expect(target.querySelector(".meta")?.textContent).toBe("attempt 3 · 01:05");
  });

  test("shows only the time elapsed before the first attempt", async () => {
    const target = await dropConnection();

    expect(target.querySelector(".meta")?.textContent).toBe("00:00");
  });

  test("offers no actions in a browser, even one on a devserver", async () => {
    history.replaceState(null, "", "/?lib=dev-1");
    const target = await dropConnection();

    expect(target.querySelector(".actions")).toBeNull();
  });

  test("offers no actions on a desktop window of the local library", async () => {
    desktopWindow("local");
    const target = await dropConnection();

    expect(target.querySelector(".actions")).toBeNull();
  });
});

describe("recovering a devserver-backed desktop window", () => {
  test("Reconnect and Abandon each ask the desktop", async () => {
    desktopWindow("dev-1");
    const target = await dropConnection();

    button(target, "Reconnect").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("reconnect_devserver_for_window", undefined));
    await vi.waitFor(() => expect(button(target, "Abandon").disabled).toBe(false));
    button(target, "Abandon").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("abandon_devserver_for_window", undefined));
  });

  test("a pending action says so and holds both buttons", async () => {
    desktopWindow("dev-1");
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    const target = await dropConnection();

    button(target, "Reconnect").click();
    await tick();

    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".actions button")];
    expect(buttons.map((b) => [b.textContent?.trim(), b.disabled])).toEqual([
      ["Reconnecting...", true],
      ["Abandon", true],
    ]);

    finish();
    await vi.waitFor(() => expect(button(target, "Reconnect")?.disabled).toBe(false));
  });

  test("a refused action shows the desktop's reason", async () => {
    desktopWindow("dev-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("not allowed for this window"));
    const target = await dropConnection();

    button(target, "Abandon").click();

    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toBe("not allowed for this window"),
    );
  });
});

describe("the desktop's recovery calls", () => {
  test("refuse outside the desktop", async () => {
    await expect(reconnectDevserverForWindow()).rejects.toThrow("not running under Tauri");
    await expect(abandonDevserverForWindow()).rejects.toThrow("not running under Tauri");
  });

  test("log a refused call and pass the failure on", async () => {
    desktopWindow("dev-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("denied"));

    await expect(reconnectDevserverForWindow()).rejects.toThrow("denied");
    await expect(abandonDevserverForWindow()).rejects.toThrow("denied");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
