// A sentence that names a draft reaches the status bar from many call sites,
// each interpolating a path. Whatever wrote it, the bar shows the draft's
// display path: never the mark, never the lifetime id.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import { draftClientPath } from "../api/fileIdentity";
import { notify, setNotifyHandler } from "../state/notify.svelte";
import { dismissStatus, setTransientStatus, ui } from "../state/store.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

const MARK = String.fromCharCode(0);
const DRAFT = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  document.body.innerHTML = "";
  dismissStatus();
  vi.restoreAllMocks();
});

function statusText(): string {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(AppStatusBar, { target }));
  flushSync();
  return target.querySelector('[aria-label="status message"]')?.textContent ?? "";
}

test("a status set directly shows a draft by its display path", () => {
  ui.status = `${DRAFT} was not saved`;
  ui.statusKind = "persistent";

  const text = statusText();

  expect(text.includes(MARK), "the mark in the bar").toBe(false);
  expect(text.includes("abc"), "the lifetime id in the bar").toBe(false);
  expect(text, "the sentence shown").toContain("Drafts/untitled/draft.md was not saved");
});

test("a transient status shows a draft by its display path", () => {
  setTransientStatus(`Copied ${DRAFT}`);

  const text = statusText();

  expect(text.includes(MARK), "the mark in the bar").toBe(false);
  expect(text, "the sentence shown").toContain("Copied Drafts/untitled/draft.md");
});

test("a notification hands its handler the display path", () => {
  const seen: string[] = [];
  setNotifyHandler((msg) => seen.push(msg));

  notify(`Draft close failed for ${DRAFT}`);

  expect(seen, "what the handler received").toEqual([
    "Draft close failed for Drafts/untitled/draft.md",
  ]);
});
