// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ remote: false }));
vi.mock("../state/linkHealth.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/linkHealth.svelte")>()),
  linkIsRemote: () => host.remote,
}));

import AppStatusBar from "./AppStatusBar.svelte";
import { linkHealth, resetLinkHealthForTests } from "../state/linkHealth.svelte";
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
  resetLinkHealthForTests();
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

function state(next: typeof linkHealth.state, waitMs = 0): void {
  linkHealth.state = next;
  linkHealth.waitMs = waitMs;
  flushSync();
}

function section(): HTMLElement | null {
  return target.querySelector<HTMLElement>(".link-section");
}

test("link alone controls the bar for each unhealthy state and stays quiet while healthy", () => {
  state("ok");
  render();
  expect(target.querySelector(".app-statusbar")).toBeNull();
  for (const next of ["slow", "stalled", "down"] as const) {
    state(next, 8_100);
    expect(section()).not.toBeNull();
    expect(target.querySelector(".app-statusbar")).not.toBeNull();
    expect(section()?.querySelector(".link-indicator")?.getAttribute("data-state")).toBe(next);
  }
});

test("a window tab bar removes the status link section", () => {
  state("slow");
  render();
  expect(section()).not.toBeNull();
  windowTabBar.on = true;
  flushSync();
  expect(section()).toBeNull();
  expect(target.querySelector(".app-statusbar")).toBeNull();
});

test("a remote healthy window has no status link or empty close-only pill", () => {
  host.remote = true;
  state("ok");
  render();
  expect(section()).toBeNull();
  expect(target.querySelector(".app-statusbar")).toBeNull();
});

test("link comes first and has one separator before an index neighbour", () => {
  state("slow");
  indexStatus.value = { state: "reindexing", file: "a.md" } as IndexStatus;
  render();
  const row = target.querySelector(".row")!;
  expect([...row.children].map((child) => child.classList.contains("sep") ? "sep" : child.classList.contains("link-section") ? "link" : "index"))
    .toEqual(["link", "sep", "index"]);
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
] as const)("link has one separator before a lone %s section", (_name, neighbour) => {
  state("slow");
  neighbour();
  render();
  const row = target.querySelector(".row")!;
  expect([...row.children].map((child) => child.classList.contains("sep") ? "sep" : child.classList.contains("link-section") ? "link" : "neighbour"))
    .toEqual(["link", "sep", "neighbour"]);
});

test("the link wrapper uses the close spacing of other sections", () => {
  state("slow");
  render();
  expect(section()?.classList.contains("closable")).toBe(true);
  expect(section()?.classList.contains("section")).toBe(false);
});

test("collapsed link has a close that hides it until its state changes", () => {
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

test("section close keeps a counting stalled link hidden until state changes", () => {
  state("stalled", 8_100);
  render();
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

test("pressing link opens its popover without collapsing the status bar", () => {
  state("slow");
  render();
  const button = section()?.querySelector<HTMLButtonElement>(".link-indicator")!;
  button.click();
  flushSync();
  expect(document.body.querySelector(".link-popover")).not.toBeNull();
  expect(target.querySelector(".app-statusbar")?.classList.contains("collapsed")).toBe(false);
});
