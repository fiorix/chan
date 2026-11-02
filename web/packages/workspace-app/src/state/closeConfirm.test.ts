// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  isTauriDesktop: () => true,
  hideWindowFromCloseConfirm: vi.fn(async (): Promise<string | null> => null),
  closeWindowRefusal: vi.fn(async (): Promise<string | null> => null),
  requestCloseWindow: vi.fn(async () => {}),
}));

import { closeWindowRefusal, hideWindowFromCloseConfirm, requestCloseWindow } from "../api/desktop";
import {
  closeConfirmState,
  flushAndCloseWindow,
  flushAndHideWindow,
  resolveCloseConfirm,
  uiCloseConfirm,
} from "./closeConfirm.svelte";
import { ui } from "./store.svelte";

afterEach(() => {
  // Drop any resolver a test left pending so it can't leak into the next one.
  resolveCloseConfirm("cancel");
  vi.clearAllMocks();
});

describe("closeConfirm", () => {
  it("opens and resolves the chosen action", async () => {
    for (const choice of ["hide", "close", "cancel"] as const) {
      const p = uiCloseConfirm();
      expect(closeConfirmState.open).toBe(true);
      resolveCloseConfirm(choice);
      expect(closeConfirmState.open).toBe(false);
      expect(closeConfirmState.resolve).toBeNull();
      await expect(p).resolves.toBe(choice);
    }
  });

  it("a second open resolves the prior prompt as a cancel", async () => {
    const first = uiCloseConfirm();
    const second = uiCloseConfirm();
    // The superseded prompt resolves cancel (its window stayed open); the second
    // is now the live one.
    await expect(first).resolves.toBe("cancel");
    expect(closeConfirmState.open).toBe(true);
    resolveCloseConfirm("hide");
    await expect(second).resolves.toBe("hide");
  });

  it("a hide the desktop refuses answers its reason and shows it in the status bar", async () => {
    const reason = "this is chan's last shown window: hiding it would quit chan and end 1 running terminal session(s); show or open another window first";
    vi.mocked(hideWindowFromCloseConfirm).mockResolvedValueOnce(reason);

    await expect(flushAndHideWindow()).resolves.toBe(reason);
    expect(ui.status).toBe(reason);
  });

  it("a hide that goes ahead answers no reason", async () => {
    ui.status = "";
    await expect(flushAndHideWindow()).resolves.toBeNull();
    expect(ui.status).toBe("");
  });

  it("a close with a discard the desktop refuses discards and closes nothing and shows why", async () => {
    const reason = "this is chan's last shown window: closing it would quit chan and end 1 other running terminal session(s); show or open another window first";
    vi.mocked(closeWindowRefusal).mockResolvedValueOnce(reason);
    const discard = vi.fn();

    await expect(flushAndCloseWindow({ discard })).resolves.toBe(reason);
    expect(discard).not.toHaveBeenCalled();
    expect(requestCloseWindow).not.toHaveBeenCalled();
    expect(ui.status).toBe(reason);
  });

  it("a close with a discard the desktop does not refuse discards, then closes", async () => {
    const discard = vi.fn();
    await expect(flushAndCloseWindow({ discard })).resolves.toBeNull();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
    expect(discard.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestCloseWindow).mock.invocationCallOrder[0]!);
  });

  it("a close no longer wanted when the desktop answers discards and closes nothing", async () => {
    const discard = vi.fn();
    await expect(flushAndCloseWindow({ discard, stillWanted: () => false })).resolves.toBeNull();
    expect(discard).not.toHaveBeenCalled();
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });

  it("a close without a discard is not asked about", async () => {
    await flushAndCloseWindow();
    expect(closeWindowRefusal).not.toHaveBeenCalled();
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
  });

  it("resolving with no pending prompt is a no-op", () => {
    expect(() => resolveCloseConfirm("cancel")).not.toThrow();
    expect(closeConfirmState.open).toBe(false);
  });
});
