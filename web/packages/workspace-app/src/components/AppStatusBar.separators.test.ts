// @vitest-environment jsdom
//
// The status bar sets one separator between neighbouring pills, whichever
// of them are showing.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";

import AppStatusBar from "./AppStatusBar.svelte";
import { ui } from "../state/store.svelte";
import { paneMode } from "../state/tabs.svelte";
import { beginTransfer, transfers } from "../state/transfers.svelte";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.replaceChildren();
  paneMode.active = false;
  transfers.items = [];
  ui.status = null;
});

test("a separator stands between the transfers launcher and the Hybrid Nav pill", () => {
  ui.status = null;
  beginTransfer({ kind: "download", filename: "dump.sql", cancel: null });
  paneMode.active = true;
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(AppStatusBar, { target });
  flushSync();

  const pill = target.querySelector(".pane-mode-pill");
  expect(target.querySelector('[aria-label="show file transfers"]') && pill, "both show").toBeTruthy();
  expect(pill!.previousElementSibling?.classList.contains("sep"), "the separator before Hybrid Nav").toBe(true);
});
