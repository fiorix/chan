// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ remote: false }));
vi.mock("../state/connectionHealth.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/connectionHealth.svelte")>()),
  connectionIsRemote: () => host.remote,
}));

import AppStatusBar from "./AppStatusBar.svelte";
import { APP_STATUS_PILL_SELECTOR } from "./terminalNoticePlacement";
import { connectionHealth, resetConnectionHealthForTests } from "../state/connectionHealth.svelte";
import { importStatus, indexStatus, ui } from "../state/store.svelte";
import { windowTabBar } from "../state/windowTabBar.svelte";
import { paneMode } from "../state/tabs.svelte";
import { beginTransfer, transfers } from "../state/transfers.svelte";
import { sessionState } from "../state/session.svelte";
import { sessionWindowId } from "../api/client";
import type { IndexStatus } from "../api/types";

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.replaceChildren();
  resetConnectionHealthForTests();
  windowTabBar.on = false;
  indexStatus.value = null;
  importStatus.value = null;
  transfers.items = [];
  paneMode.active = false;
  sessionState.participants = [];
  sessionState.leader = null;
  ui.status = null;
  host.remote = false;
});

function render(): void {
  target = document.body.appendChild(document.createElement("div"));
  view = mount(AppStatusBar, { target });
  flushSync();
}

function state(next: typeof connectionHealth.state, waitMs = 0): void {
  connectionHealth.state = next;
  connectionHealth.waitMs = waitMs;
  flushSync();
}

function section(): HTMLElement | null {
  return target.querySelector<HTMLElement>(".connection-section");
}

test("a visible status pill exposes its layout selector", () => {
  state("slow");
  render();
  expect(target.querySelector(APP_STATUS_PILL_SELECTOR)).not.toBeNull();
});

test("connection alone controls the bar for each unhealthy state and stays quiet while healthy", () => {
  state("ok");
  render();
  expect(target.querySelector(".app-statusbar")).toBeNull();
  for (const next of ["slow", "stalled", "down"] as const) {
    state(next, 8_100);
    expect(section()).not.toBeNull();
    expect(target.querySelector(".app-statusbar")).not.toBeNull();
    expect(section()?.querySelector(".connection-indicator")?.getAttribute("data-state")).toBe(next);
  }
});

test("recovering connection leaves a glyph-only status pill section", () => {
  connectionHealth.rttMs = 26;
  state("slow");
  render();
  expect(section()?.querySelector(".connection-indicator .glyph")).not.toBeNull();
  expect(section()?.querySelector(".connection-indicator .label")).toBeNull();
});

test("a window tab bar removes the status connection section", () => {
  state("slow");
  render();
  expect(section()).not.toBeNull();
  windowTabBar.on = true;
  flushSync();
  expect(section()).toBeNull();
  expect(target.querySelector(".app-statusbar")).toBeNull();
});

test("a remote healthy window has no status connection or empty close-only pill", () => {
  host.remote = true;
  state("ok");
  render();
  expect(section()).toBeNull();
  expect(target.querySelector(".app-statusbar")).toBeNull();
});

test("connection comes first and has one separator before an index neighbour", () => {
  state("slow");
  indexStatus.value = { state: "reindexing", file: "a.md" } as IndexStatus;
  render();
  const row = target.querySelector(".row")!;
  expect([...row.children].map((child) => child.classList.contains("sep") ? "sep" : child.classList.contains("connection-section") ? "connection" : "index"))
    .toEqual(["connection", "sep", "index"]);
});

test.each([
  ["import", () => { importStatus.value = { label: "importing" }; }],
  ["transfers", () => { beginTransfer({ kind: "upload", filename: "a.bin", cancel: null }); }],
  ["status", () => { ui.status = "working"; }],
  ["Hybrid Nav", () => { paneMode.active = true; }],
  ["role", () => {
    sessionState.leader = sessionWindowId();
    sessionState.participants = [
      { window_id: sessionWindowId(), name: null, role: "leader", status: "live" },
      { window_id: "remote-1", name: null, role: "follower", status: "live" },
    ];
  }],
] as const)("connection has one separator before a lone %s section", (_name, neighbour) => {
  state("slow");
  neighbour();
  render();
  const row = target.querySelector(".row")!;
  expect([...row.children].map((child) => child.classList.contains("sep") ? "sep" : child.classList.contains("connection-section") ? "connection" : "neighbour"))
    .toEqual(["connection", "sep", "neighbour"]);
});

test("the connection wrapper uses the close spacing of other sections", () => {
  state("slow");
  render();
  expect(section()?.classList.contains("closable")).toBe(true);
  expect(section()?.classList.contains("section")).toBe(false);
});

test("collapsed connection has a close that hides it until its state changes", () => {
  state("stalled", 8_100);
  render();
  target.querySelector<HTMLButtonElement>(".collapse")!.click();
  flushSync();
  expect(target.querySelector('[aria-label="close all status"]')).not.toBeNull();
  target.querySelector<HTMLButtonElement>('[aria-label="close all status"]')!.click();
  flushSync();
  expect(target.querySelector(".app-statusbar")).toBeNull();
  state("stalled", 9_100);
  expect(target.querySelector(".app-statusbar"), "a counting label is the same content").toBeNull();
  state("down");
  expect(target.querySelector(".app-statusbar"), "a new state returns the collapsed chip").not.toBeNull();
  expect(target.querySelector(".collapsed")).not.toBeNull();
});

test("section close keeps a counting stalled connection hidden until state changes", () => {
  state("stalled", 8_100);
  render();
  expect(target.querySelector<HTMLButtonElement>('[aria-label="hide connection status"]')?.title).toBe("Hide until the connection state changes");
  target.querySelector<HTMLButtonElement>('[aria-label="hide connection status"]')!.click();
  flushSync();
  expect(section()).toBeNull();
  state("stalled", 9_100);
  expect(section()).toBeNull();
  state("slow");
  expect(section()).not.toBeNull();
});

test("section close remembers states already seen in an unhealthy spell and resets on ok or unknown", () => {
  state("slow");
  render();
  const close = () => {
    target.querySelector<HTMLButtonElement>('[aria-label="hide connection status"]')!.click();
    flushSync();
  };
  close();
  expect(section()).toBeNull();
  state("stalled", 8_100);
  expect(section()).not.toBeNull();
  close();
  expect(section()).toBeNull();
  state("slow");
  expect(section(), "slow was already closed in this spell").toBeNull();
  state("down");
  expect(section(), "down is a new state in this spell").not.toBeNull();
  close();
  state("stalled", 9_100);
  expect(section(), "stalled was already closed in this spell").toBeNull();
  state("ok");
  expect(section()).toBeNull();
  state("slow");
  expect(section(), "a new spell has a fresh close record").not.toBeNull();
  close();
  state("stalled", 8_100);
  expect(section(), "stalled is new in the spell after ok").not.toBeNull();
  close();
  state("unknown");
  expect(section()).toBeNull();
  state("slow");
  expect(section(), "unknown also starts a fresh spell").not.toBeNull();
  close();
  state("stalled", 8_100);
  expect(section(), "stalled is new in the spell after unknown").not.toBeNull();
});

test("pressing connection opens its popover without collapsing the status bar", () => {
  state("slow");
  render();
  const button = section()?.querySelector<HTMLButtonElement>(".connection-indicator")!;
  button.click();
  flushSync();
  expect(document.body.querySelector(".connection-popover")).not.toBeNull();
  expect(target.querySelector(".app-statusbar")?.classList.contains("collapsed")).toBe(false);
});
