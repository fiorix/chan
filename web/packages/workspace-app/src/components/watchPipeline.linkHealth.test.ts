// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { setSocketFactory } from "../api/transport";
import { linkHealth, resetLinkHealthForTests } from "../state/linkHealth.svelte";
import { resumeWatcher, teardown, ui } from "../state/store.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeSocket.instances.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  pong(): void {
    this.onmessage?.({ data: '{"type":"pong"}' });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  teardown();
  resetLinkHealthForTests();
  setSocketFactory(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (document as unknown as Record<string, unknown>).hasFocus;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
});

test("a real watcher status bridge carries a deadline and a close to the window cover", async () => {
  vi.useFakeTimers();
  teardown();
  resetLinkHealthForTests();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  history.replaceState(null, "", "/?lib=dev-1");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  setSocketFactory(() => new FakeSocket() as unknown as WebSocket);
  const target = document.body.appendChild(document.createElement("div"));
  const view = mount(DisconnectOverlay, { target });
  resumeWatcher();
  const first = FakeSocket.instances[0];
  first.open();
  first.pong();
  await tick();
  expect(ui.ws).toBe("open");
  expect(linkHealth.state).toBe("ok");
  const contact = Date.now();

  vi.advanceTimersByTime(15_000);
  await tick();
  expect(first.readyState).toBe(3);
  expect(ui.ws).toBe("reconnecting");
  expect(linkHealth.outage?.coverAt).toBe(contact + 45_000);
  expect(target.querySelector(".overlay")).toBeNull();
  vi.advanceTimersByTime(500);
  const redial = FakeSocket.instances.at(-1)!;
  redial.open();
  await tick();
  expect(linkHealth.state).toBe("down");
  for (let i = 0; i < 2; i += 1) {
    vi.advanceTimersByTime(10_000);
    redial.onmessage?.({ data: "{" });
  }
  vi.advanceTimersByTime(9_499);
  await tick();
  expect(target.querySelector(".overlay")).toBeNull();
  vi.advanceTimersByTime(1);
  await tick();
  expect(target.querySelector(".overlay")).not.toBeNull();

  await unmount(view);
  teardown();
  resetLinkHealthForTests();
  const closeTarget = document.body.appendChild(document.createElement("div"));
  const closeView = mount(DisconnectOverlay, { target: closeTarget });
  resumeWatcher();
  const second = FakeSocket.instances.at(-1)!;
  second.open();
  second.pong();
  await tick();
  expect(linkHealth.outage).toBeNull();
  expect(closeTarget.querySelector(".overlay")).toBeNull();
  second.close();
  await tick();
  expect(linkHealth.outage?.coverAt).toBe(linkHealth.outage?.startedAt);
  vi.advanceTimersByTime(500);
  await tick();
  expect(ui.ws).toBe("connecting");
  expect(closeTarget.querySelector(".overlay")).toBeNull();
  vi.advanceTimersByTime(599);
  await tick();
  expect(closeTarget.querySelector(".overlay")).toBeNull();
  vi.advanceTimersByTime(1);
  await tick();
  expect(closeTarget.querySelector(".overlay")).not.toBeNull();
  await unmount(closeView);
});

test("a real watcher pong ends the outage and clears the cover", async () => {
  vi.useFakeTimers();
  teardown();
  resetLinkHealthForTests();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  setSocketFactory(() => new FakeSocket() as unknown as WebSocket);
  const target = document.body.appendChild(document.createElement("div"));
  const view = mount(DisconnectOverlay, { target });
  resumeWatcher();
  const first = FakeSocket.instances[0];
  first.open();
  first.pong();
  await tick();
  first.close();
  await tick();
  expect(linkHealth.outage).not.toBeNull();
  vi.advanceTimersByTime(500);
  const redial = FakeSocket.instances.at(-1)!;
  redial.open();
  await tick();
  vi.advanceTimersByTime(600);
  await tick();
  expect(target.querySelector(".overlay")).not.toBeNull();
  expect(linkHealth.outage).not.toBeNull();
  redial.pong();
  await tick();
  expect(linkHealth.outage).toBeNull();
  expect(target.querySelector(".overlay")).toBeNull();
  await unmount(view);
});
