// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import {
  closeConfirmState,
  resolveCloseConfirm,
  uiCloseConfirm,
} from "../state/closeConfirm.svelte";
import { ui } from "../state/store.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resolveCloseConfirm("cancel");
  ui.ws = "connecting";
  document.body.innerHTML = "";
});

function render(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CloseConfirmOverlay, { target }) as Record<string, unknown>);
  return target;
}

describe("CloseConfirmOverlay connection lifecycle", () => {
  test("a disconnect transition resolves the pending prompt as cancel", async () => {
    ui.ws = "open";
    const target = render();
    await tick();

    const pending = uiCloseConfirm();
    await tick();
    expect(closeConfirmState.open).toBe(true);
    expect(target.querySelector(".overlay")).not.toBeNull();

    ui.ws = "reconnecting";
    await tick();
    expect(closeConfirmState.open).toBe(false);
    expect(target.querySelector(".overlay")).toBeNull();
    await expect(pending).resolves.toBe("cancel");
  });

  test("a reconnect transition clears a stale pending prompt", async () => {
    ui.ws = "reconnecting";
    const target = render();
    await tick();

    const pending = uiCloseConfirm();
    ui.ws = "open";
    await tick();

    expect(closeConfirmState.open).toBe(false);
    expect(target.querySelector(".overlay")).toBeNull();
    await expect(pending).resolves.toBe("cancel");
  });
});
