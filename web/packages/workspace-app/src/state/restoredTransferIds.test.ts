// @vitest-environment jsdom
//
// A transfer id is unique among every record the window holds, restored or
// new. The mint counter starts at 1 on every load while `restoreTransfers`
// replays persisted ids verbatim, so the first transfer started after a reload
// takes an id a restored row already holds.
//
// This file holds exactly one test on purpose: the counter is module state, so
// a second test here would run against a counter the first one advanced and
// could not express the collision the reload produces.

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { sessionWindowId } from "../api/client";
import TransferBubble from "../components/TransferBubble.svelte";
import {
  activeTransferCount,
  beginTransfer,
  finishTransfer,
  showTransfers,
  transfers,
} from "./transfers.svelte";
import { restoreTransfers } from "./transfers.svelte";

let bubble: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (bubble) unmount(bubble);
  bubble = null;
  target?.remove();
  target = null;
  transfers.items = [];
  transfers.shown = false;
  window.sessionStorage.clear();
});

/// The payload a previous load left behind: two settled downloads carrying the
/// ids that load's counter minted.
function seedPersistedTransfers(): string[] {
  const window_ = sessionWindowId();
  const ids = [`xfer-${window_}-1`, `xfer-${window_}-2`];
  window.sessionStorage.setItem(
    `chan.transfers:${window_}`,
    JSON.stringify({
      shown: true,
      items: ids.map((id, i) => ({
        id,
        kind: "download",
        filename: `old-${i}.bin`,
        progress: null,
        state: "done",
        error: null,
        savedPath: `/downloads/old-${i}.bin`,
        source: { path: `old-${i}.bin`, isDir: false },
      })),
    }),
  );
  return ids;
}

describe("transfer ids after a reload", () => {
  test("a new transfer does not reuse a restored id", () => {
    const restored = seedPersistedTransfers();
    restoreTransfers(() => () => {});
    expect(transfers.items.map((t) => t.id)).toEqual(restored);

    const live = beginTransfer({
      kind: "upload",
      filename: "new.bin",
      cancel: null,
    });

    // Soft assertions: the id collision is the defect, and the two lines
    // below are its consequences. A hard failure on the first would hide
    // whether the other two actually follow from it.
    expect.soft(new Set([...restored, live]).size).toBe(3);

    // The bubble keys its rows by id, so a duplicate is a render-time throw.
    showTransfers();
    target = document.createElement("div");
    document.body.append(target);
    expect.soft(() => {
      bubble = mount(TransferBubble, { target: target! });
    }).not.toThrow();
    expect.soft(target.querySelectorAll(".tb-row")).toHaveLength(3);

    // And the live transfer must be the one that settles, so the close guard
    // stops counting it.
    finishTransfer(live, "/downloads/new.bin");
    expect.soft(activeTransferCount()).toBe(0);
  });
});
