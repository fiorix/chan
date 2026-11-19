// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WatchDrop } from "../api/transport";
import { connectionHealth, resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { raisedCoverKeys, ui } from "../state/store.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
});

afterEach(async () => {
  for (const view of mounted.splice(0)) await unmount(view);
  resetConnectionHealthForTests();
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
  setConnectionWatchStatus("open");
  ui.ws = "open";
  const target = await render();
  watchConnectionProbe.pingSent();
  watchConnectionProbe.frameReceived();
  watchConnectionProbe.pongReceived();
  await tick();
  return target;
}

async function drop(drop: WatchDrop): Promise<void> {
  watchConnectionProbe.reset();
  setConnectionWatchStatus("reconnecting", drop);
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
  expect(connectionHealth.state).toBe("down");
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
  expect(connectionHealth.outage?.coverAt).toBe(connectionHealth.outage?.startedAt);
  await advance(599);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
});

test("a closed socket healed by a pong inside grace never covers", async () => {
  const target = await open();
  await drop({ reason: "closed", lastFrameAt: Date.now() });
  await advance(300);
  setConnectionWatchStatus("open");
  ui.ws = "open";
  watchConnectionProbe.pingSent();
  watchConnectionProbe.frameReceived();
  watchConnectionProbe.pongReceived();
  await tick();
  await advance(400);
  expect(connectionHealth.outage).toBeNull();
  expect(cover(target)).toBeNull();
});

test("a status flip just before a delayed deadline gets a fresh 600 ms grace", async () => {
  const target = await open();
  const lastFrameAt = Date.now();
  await advance(15_000);
  await drop({ reason: "deadline", lastFrameAt });
  await advance(29_900);
  setConnectionWatchStatus("connecting");
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
  setConnectionWatchStatus("connecting");
  ui.ws = "connecting";
  await tick();
  await advance(100);
  expect(cover(target)).toBeNull();
  await advance(499);
  expect(cover(target)).toBeNull();
  await advance(1);
  expect(cover(target)).not.toBeNull();
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
  setConnectionWatchStatus("connecting");
  ui.ws = "connecting";
  await tick();
  setConnectionWatchStatus("open");
  ui.ws = "open";
  watchConnectionProbe.pingSent();
  await tick();
  expect(connectionHealth.state).toBe("down");
  await advance(100);
  watchConnectionProbe.frameReceived();
  watchConnectionProbe.pongReceived();
  await tick();
  await advance(30_000);
  expect(connectionHealth.state).toBe("ok");
  expect(cover(target)).toBeNull();
});

test("a flap holds one cover and one action delay until a later socket's pong", async () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null };
  history.replaceState(null, "", "/?lib=dev-1");
  const target = await open();
  await drop({ reason: "closed", lastFrameAt: Date.now() });
  const outage = connectionHealth.outage;
  await advance(600);
  expect(cover(target)).not.toBeNull();
  setConnectionWatchStatus("connecting");
  ui.ws = "connecting";
  setConnectionWatchStatus("open");
  ui.ws = "open";
  watchConnectionProbe.pingSent();
  await tick();
  expect(connectionHealth.state).toBe("down");
  expect(cover(target)).not.toBeNull();
  await advance(7_400);
  expect(target.querySelector(".actions button")).not.toBeNull();
  watchConnectionProbe.reset();
  setConnectionWatchStatus("reconnecting", { reason: "deadline", lastFrameAt: null });
  ui.ws = "reconnecting";
  await tick();
  expect(connectionHealth.outage).toBe(outage);
  expect(cover(target)).not.toBeNull();
  expect(target.querySelector(".actions button")).not.toBeNull();
  setConnectionWatchStatus("open");
  ui.ws = "open";
  watchConnectionProbe.pingSent();
  await tick();
  expect(cover(target)).not.toBeNull();
  watchConnectionProbe.frameReceived();
  watchConnectionProbe.pongReceived();
  await tick();
  expect(connectionHealth.outage).toBeNull();
  expect(cover(target)).toBeNull();
});
