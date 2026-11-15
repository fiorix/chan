// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import { resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { linkHealth, resetLinkHealthForTests, setLinkWatchStatus, watchLinkProbe } from "../state/linkHealth.svelte";
import { ui } from "../state/store.svelte";

const mounted: Array<Record<string, unknown>> = [];
let target: HTMLElement;

beforeEach(async () => {
  resetLinkHealthForTests();
  ui.disconnectBlocking = false;
  ui.ws = "open";
  setLinkWatchStatus("open");
  target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(CloseConfirmOverlay, { target }) as Record<string, unknown>);
  await tick();
});

afterEach(async () => {
  resolveCloseConfirm("cancel");
  for (const component of mounted.splice(0)) await unmount(component);
  resetLinkHealthForTests();
  ui.ws = "connecting";
  ui.disconnectBlocking = false;
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function drop(): Promise<void> {
  watchLinkProbe.reset();
  setLinkWatchStatus("reconnecting", { reason: "closed", lastFrameAt: Date.now() });
  ui.ws = "reconnecting";
  await tick();
}

describe("CloseConfirmOverlay connection lifecycle", () => {
  test("a healthy window opens a close prompt", async () => {
    const answer = uiCloseConfirm();
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    resolveCloseConfirm("cancel");
    await expect(answer).resolves.toBe("cancel");
  });

  test("the loss of an open watcher cancels a pending prompt", async () => {
    const answer = uiCloseConfirm();
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    await drop();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    await expect(answer).resolves.toBe("cancel");
  });

  test("a prompt opened after the watcher drops survives redial status changes", async () => {
    await drop();
    const answer = uiCloseConfirm();
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    setLinkWatchStatus("connecting");
    ui.ws = "connecting";
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    setLinkWatchStatus("open");
    ui.ws = "open";
    await tick();
    expect(linkHealth.outage).not.toBeNull();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    resolveCloseConfirm("cancel");
    await expect(answer).resolves.toBe("cancel");
  });

  test("the redialed socket's first pong cancels a prompt opened during its outage", async () => {
    await drop();
    const answer = uiCloseConfirm();
    await tick();
    setLinkWatchStatus("open");
    ui.ws = "open";
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    watchLinkProbe.pingSent();
    watchLinkProbe.frameReceived();
    watchLinkProbe.pongReceived();
    await tick();
    expect(linkHealth.outage).toBeNull();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    await expect(answer).resolves.toBe("cancel");
  });

  test("the real reconnecting cover cancels a prompt opened during an outage", async () => {
    vi.useFakeTimers();
    const coverTarget = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(DisconnectOverlay, { target: coverTarget }) as Record<string, unknown>);
    await tick();
    await drop();
    const answer = uiCloseConfirm();
    await tick();
    vi.advanceTimersByTime(599);
    await tick();
    expect(target.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(coverTarget.querySelector(".overlay")).toBeNull();
    vi.advanceTimersByTime(1);
    await tick();
    await tick();
    expect(coverTarget.querySelector(".overlay")).not.toBeNull();
    expect(target.querySelector('[role="alertdialog"]')).toBeNull();
    await expect(answer).resolves.toBe("cancel");
  });
});
