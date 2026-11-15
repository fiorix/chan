// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WatchDrop } from "../api/transport";
import { linkHealth, resetLinkHealthForTests, setLinkWatchStatus, watchLinkProbe } from "../state/linkHealth.svelte";
import { raisedCoverKeys, ui } from "../state/store.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import LinkIndicator from "./LinkIndicator.svelte";

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetLinkHealthForTests();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
});

afterEach(async () => {
  for (const view of mounted.splice(0)) await unmount(view);
  resetLinkHealthForTests();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
  document.body.replaceChildren();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
  vi.useRealTimers();
});

async function render(): Promise<HTMLElement> {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(DisconnectOverlay, { target }) as Record<string, unknown>);
  await tick();
  return target;
}

async function open(): Promise<HTMLElement> {
  setLinkWatchStatus("open");
  ui.ws = "open";
  const target = await render();
  watchLinkProbe.pingSent();
  watchLinkProbe.frameReceived();
  watchLinkProbe.pongReceived();
  await tick();
  return target;
}

async function drop(drop: WatchDrop): Promise<void> {
  watchLinkProbe.reset();
  setLinkWatchStatus("reconnecting", drop);
  ui.ws = "reconnecting";
  await tick();
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await tick();
}

function cover(target: HTMLElement): Element | null {
  return target.querySelector(".overlay");
}

test.each([
  ["fast read retire", 15_000, 30_000],
  ["ordinary read retire", 45_000, 600],
  ["wake probe with recent contact", 5_000, 40_000],
  ["wake probe with old contact", 60_000, 600],
] as const)("%s shows the cover at the old silence deadline", async (_name, contactAge, due) => {
  const target = await open();
  const lastFrameAt = Date.now();
  await advance(contactAge);
  await drop({ reason: "deadline", lastFrameAt });
  expect(linkHealth.state).toBe("down");
  expect(cover(target)).toBeNull();
  expect(ui.disconnectBlocking).toBe(false);
  expect(raisedCoverKeys()).not.toContain("reconnect");
  await advance(due - 1);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
  expect(ui.disconnectBlocking).toBe(true);
});

test("a socket closed by the network covers after the 600 ms grace", async () => {
  const target = await open();
  await drop({ reason: "closed", lastFrameAt: Date.now() });
  expect(linkHealth.outage?.coverAt).toBe(linkHealth.outage?.startedAt);
  await advance(599);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
});

test("a closed socket healed by a pong inside grace never covers", async () => {
  const target = await open();
  await drop({ reason: "closed", lastFrameAt: Date.now() });
  await advance(300);
  setLinkWatchStatus("open");
  ui.ws = "open";
  watchLinkProbe.pingSent();
  watchLinkProbe.frameReceived();
  watchLinkProbe.pongReceived();
  await tick();
  await advance(400);
  expect(linkHealth.outage).toBeNull();
  expect(cover(target)).toBeNull();
});

test("a status flip just before a delayed deadline gets a fresh 600 ms grace", async () => {
  const target = await open();
  const lastFrameAt = Date.now();
  await advance(15_000);
  await drop({ reason: "deadline", lastFrameAt });
  await advance(29_900);
  setLinkWatchStatus("connecting");
  ui.ws = "connecting";
  await tick();
  await advance(100);
  expect(cover(target)).toBeNull();
  await advance(499);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
});

test("an old-contact wake retirement still restarts the grace on a status flip", async () => {
  const target = await open();
  const lastFrameAt = Date.now();
  await advance(60_000);
  await drop({ reason: "deadline", lastFrameAt });
  await advance(500);
  setLinkWatchStatus("connecting");
  ui.ws = "connecting";
  await tick();
  await advance(100);
  expect(cover(target)).toBeNull();
  await advance(499);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
});

test("the reconnecting indicator stays pressable until the cover appears", async () => {
  const target = await open();
  const lastFrameAt = Date.now();
  const indicatorTarget = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(LinkIndicator, { target: indicatorTarget, props: { placement: "status" } }) as Record<string, unknown>);
  await advance(15_000);
  await drop({ reason: "deadline", lastFrameAt });
  const button = indicatorTarget.querySelector<HTMLButtonElement>(".link-indicator")!;
  button.click();
  await tick();
  expect(document.body.querySelector(".link-popover")).not.toBeNull();
  expect(cover(target)).toBeNull();
  await advance(30_000);
  expect(cover(target)).not.toBeNull();
  expect(document.body.querySelector(".link-popover")).toBeNull();
});

test("a late cover opens with recovery actions ready and does not block keys before then", async () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null };
  history.replaceState(null, "", "/?lib=dev-1");
  const input = document.body.appendChild(document.createElement("textarea"));
  const keys: string[] = [];
  input.addEventListener("keydown", (event) => keys.push(event.key));
  const target = await open();
  input.focus();
  const lastFrameAt = Date.now();
  await advance(15_000);
  await drop({ reason: "deadline", lastFrameAt });
  await advance(29_999);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  expect(keys).toEqual(["a"]);
  expect(document.activeElement).toBe(input);
  expect(ui.disconnectBlocking).toBe(false);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(target.querySelector(".actions button")).not.toBeNull();
  expect(target.querySelector(".meta")?.textContent).toContain("00:30");
  expect(document.activeElement).toBe(cover(target));
});

test("a pong before the late cover deadline cancels the cover", async () => {
  const target = await open();
  const lastFrameAt = Date.now();
  await advance(15_000);
  await drop({ reason: "deadline", lastFrameAt });
  await advance(500);
  setLinkWatchStatus("connecting");
  ui.ws = "connecting";
  await tick();
  setLinkWatchStatus("open");
  ui.ws = "open";
  watchLinkProbe.pingSent();
  await tick();
  expect(linkHealth.state).toBe("down");
  await advance(100);
  watchLinkProbe.frameReceived();
  watchLinkProbe.pongReceived();
  await tick();
  await advance(30_000);
  expect(linkHealth.state).toBe("ok");
  expect(cover(target)).toBeNull();
});

test("a flap holds one cover and one action delay until a later socket's pong", async () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null };
  history.replaceState(null, "", "/?lib=dev-1");
  const target = await open();
  await drop({ reason: "closed", lastFrameAt: Date.now() });
  const outage = linkHealth.outage;
  await advance(600);
  expect(cover(target)).not.toBeNull();
  setLinkWatchStatus("connecting");
  ui.ws = "connecting";
  setLinkWatchStatus("open");
  ui.ws = "open";
  watchLinkProbe.pingSent();
  await tick();
  expect(linkHealth.state).toBe("down");
  expect(cover(target)).not.toBeNull();
  await advance(7_400);
  expect(target.querySelector(".actions button")).not.toBeNull();
  watchLinkProbe.reset();
  setLinkWatchStatus("reconnecting", { reason: "deadline", lastFrameAt: null });
  ui.ws = "reconnecting";
  await tick();
  expect(linkHealth.outage).toBe(outage);
  expect(cover(target)).not.toBeNull();
  expect(target.querySelector(".actions button")).not.toBeNull();
  setLinkWatchStatus("open");
  ui.ws = "open";
  watchLinkProbe.pingSent();
  await tick();
  expect(cover(target)).not.toBeNull();
  watchLinkProbe.frameReceived();
  watchLinkProbe.pongReceived();
  await tick();
  expect(linkHealth.outage).toBeNull();
  expect(cover(target)).toBeNull();
});
