// @vitest-environment jsdom
//
// The desktop's close prompt is a decision, not a wait: no spinner, and three
// actions. Hide buries the window through the desktop and keeps its session,
// Close discards the session and has the desktop close the window, and Cancel
// keeps everything. Escape cancels, and focus starts on Cancel, so Enter
// never closes a window by default.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  hideWindowFromCloseConfirm: vi.fn(async () => {}),
  requestCloseWindow: vi.fn(async () => {}),
}));

vi.mock("../state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/store.svelte")>()),
  discardWindowSession: vi.fn(async () => {}),
}));

const tmuxRequest = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, tmuxRequest } };
});

import { hideWindowFromCloseConfirm, requestCloseWindow } from "../api/desktop";
import { resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { discardWindowSession, ui } from "../state/store.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

beforeEach(async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke: async () => {} };
  ui.ws = "open";
  target = document.createElement("div");
  document.body.append(target);
  view = mount(CloseConfirmOverlay, { target });
  await tick();
});

afterEach(() => {
  resolveCloseConfirm("cancel");
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  ui.ws = "connecting";
  vi.clearAllMocks();
});

/// Raise the prompt and let it draw; answers the pending choice.
async function ask(): Promise<{ answer: Promise<string> }> {
  const answer = uiCloseConfirm();
  await tick();
  await Promise.resolve();
  return { answer };
}

function action(label: string): HTMLButtonElement {
  return [...target.querySelectorAll<HTMLButtonElement>(".actions button")].find(
    (button) => button.textContent?.trim() === label,
  )!;
}

describe("the close prompt", () => {
  test("offers Hide, Close and Cancel, with no spinner", async () => {
    await ask();

    expect([...target.querySelectorAll(".actions button")].map((b) => b.textContent?.trim())).toEqual([
      "Hide",
      "Close",
      "Cancel",
    ]);
    expect(target.querySelector(".spinner")).toBeNull();
  });

  test("Hide buries the window through the desktop and keeps its session", async () => {
    const { answer } = await ask();

    action("Hide").click();

    await expect(answer).resolves.toBe("hide");
    expect(hideWindowFromCloseConfirm).toHaveBeenCalledTimes(1);
    expect(discardWindowSession).not.toHaveBeenCalled();
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });

  test("Close discards the session and has the desktop close the window", async () => {
    const { answer } = await ask();

    action("Close").click();

    await expect(answer).resolves.toBe("close");
    expect(discardWindowSession).toHaveBeenCalledWith({ reap: true });
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
  });

  test("Close in a browser discards the session and leaves the tab to the browser", async () => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    const { answer } = await ask();

    action("Close").click();

    await expect(answer).resolves.toBe("close");
    expect(discardWindowSession).toHaveBeenCalledWith({ reap: true });
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });

  test("Cancel keeps everything", async () => {
    const { answer } = await ask();

    action("Cancel").click();

    await expect(answer).resolves.toBe("cancel");
    expect(hideWindowFromCloseConfirm).not.toHaveBeenCalled();
    expect(discardWindowSession).not.toHaveBeenCalled();
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });

  test("a tmux window offers Detach, which asks the connection through a pane and keeps the window", async () => {
    resetLayout([terminalTab({ id: "pane", title: "shell", terminalSessionId: "pane-1", tmuxPane: { connection: 1, pane: "%0" } })]);
    try {
      const { answer } = await ask();

      expect([...target.querySelectorAll(".actions button")].map((b) => b.textContent?.trim())).toEqual([
        "Hide",
        "Close",
        "Detach",
        "Cancel",
      ]);
      action("Detach").click();

      await expect(answer).resolves.toBe("cancel");
      expect(tmuxRequest).toHaveBeenCalledWith("pane-1", { request: "detach" });
      expect(discardWindowSession).not.toHaveBeenCalled();
      expect(requestCloseWindow).not.toHaveBeenCalled();
    } finally {
      resetLayout();
    }
  });

  test("Escape cancels", async () => {
    const { answer } = await ask();

    target
      .querySelector(".overlay")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    await expect(answer).resolves.toBe("cancel");
  });

  test("focus starts on Cancel, and Enter on the prompt closes nothing", async () => {
    await ask();

    expect(document.activeElement).toBe(action("Cancel"));
    target
      .querySelector(".overlay")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();

    expect(target.querySelector(".overlay")).not.toBeNull();
    expect(discardWindowSession).not.toHaveBeenCalled();
  });
});
