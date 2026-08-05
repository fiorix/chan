// @vitest-environment jsdom

// Server-authoritative transfer admission, browser half.
//
// The browser no longer decides who may start: it starts what the user asked
// for, sends the tracking headers, and renders whatever rank the server
// reports. These tests pin that split, plus the wire shape, which is validated
// at runtime rather than by the compiler. Every literal below is spelled out on
// purpose; vitest strips types, so a scoped run would otherwise pass with a
// fixture missing a required field.

import { afterEach, describe, expect, test } from "vitest";

import {
  applyTransferQueueFrame,
  beginTransfer,
  cancelTransfer,
  finishTransfer,
  transfers,
  waitForTransferSlot,
} from "./transfers.svelte";
import transfersSrc from "./transfers.svelte.ts?raw";
import clientSrc from "../api/client.ts?raw";
import storeSrc from "./store.svelte.ts?raw";
import typesSrc from "../api/types.ts?raw";

/// Every `not.toMatch` below is only as good as the string it scans: a `?raw`
/// import that resolved to nothing would satisfy all of them at once and read
/// as proof that the client-side admission machinery is gone. Prove the sources
/// actually loaded before trusting any absence claim about them.
///
/// This scans the production files only, never this test's own source. A test
/// that reads itself and asserts the absence of a string will always find that
/// string in its own assertion.
describe("the scanned sources are real", () => {
  test.each([
    ["transfers.svelte.ts", transfersSrc, "export function beginTransfer"],
    ["client.ts", clientSrc, "function uploadXhrAttempt"],
    ["store.svelte.ts", storeSrc, "export function onWatchEvent"],
    ["types.ts", typesSrc, "export type WsTransferQueueFrame"],
  ])("%s loaded and is the file we think it is", (_name, source, anchor) => {
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain(anchor);
  });
});

function resetTransfers(): void {
  transfers.items = [];
  transfers.shown = false;
  window.sessionStorage.clear();
}

afterEach(resetTransfers);

function begin(filename = "one.md"): string {
  return beginTransfer({ kind: "upload", filename, cancel: null });
}

describe("the browser makes no admission decision", () => {
  test("every begun transfer is active immediately, however many are open", () => {
    resetTransfers();
    const ids = [begin("a"), begin("b"), begin("c"), begin("d")];
    for (const id of ids) {
      expect(transfers.items.find((t) => t.id === id)?.state).toBe("active");
    }
    // No local rank is invented before the server has said anything.
    expect(transfers.items.every((t) => t.queue === null)).toBe(true);
  });

  test("waitForTransferSlot no longer waits; it only rejects a dead transfer", async () => {
    resetTransfers();
    const id = begin();
    await expect(waitForTransferSlot(id)).resolves.toBe(true);
    cancelTransfer(id);
    await expect(waitForTransferSlot(id)).resolves.toBe(false);
    await expect(waitForTransferSlot("no-such-transfer")).resolves.toBe(false);
  });

  test("the client-side concurrency machinery is gone from the source", () => {
    // Named individually: a reader restoring any one of these would be
    // reintroducing an admission decision the server owns.
    expect(transfersSrc).not.toMatch(/hasSlot/);
    expect(transfersSrc).not.toMatch(/drainQueue/);
    expect(transfersSrc).not.toMatch(/slotWaiters/);
    expect(transfersSrc).not.toMatch(/MAX_ACTIVE_(DOWNLOADS|UPLOADS)/);
  });
});

describe("applying a server frame", () => {
  test("a waiting frame records the rank", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 3 });
    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: 3 });
  });

  test("an active frame carries no position, and null is not rendered as zero", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 2 });
    // The contract omits the field entirely rather than sending 0 or null.
    applyTransferQueueFrame({ transfer_id: id, state: "active" });
    expect(transfers.items[0]!.queue).toEqual({ state: "active", position: null });
  });

  test("a rank may jump or rise; nothing assumes monotonicity", () => {
    resetTransfers();
    const id = begin();
    for (const position of [5, 2, 4, 1]) {
      applyTransferQueueFrame({ transfer_id: id, state: "waiting", position });
      expect(transfers.items[0]!.queue?.position).toBe(position);
    }
  });

  test("an unknown transfer id is dropped rather than creating a record", () => {
    resetTransfers();
    begin();
    applyTransferQueueFrame({ transfer_id: "someone-elses", state: "waiting", position: 1 });
    expect(transfers.items).toHaveLength(1);
    expect(transfers.items[0]!.queue).toBeNull();
  });

  test("a settled transfer ignores late frames and holds no stale rank", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 4 });
    finishTransfer(id);
    expect(transfers.items[0]!.queue).toBeNull();
    applyTransferQueueFrame({ transfer_id: id, state: "waiting", position: 9 });
    expect(transfers.items[0]!.queue).toBeNull();
  });

  test("a non-numeric position degrades to no rank instead of NaN", () => {
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({
      transfer_id: id,
      state: "waiting",
      position: undefined,
    });
    expect(transfers.items[0]!.queue).toEqual({ state: "waiting", position: null });
  });
});

describe("transfer ids cannot collide across windows", () => {
  test("the id embeds the window, so a foreign frame cannot match ours", () => {
    // transfer_id is the ONLY key a frame can be matched on, and window_id is
    // caller-asserted, so a bare per-window counter would let another window's
    // "xfer-1" land on ours.
    resetTransfers();
    const id = begin();
    expect(id).not.toMatch(/^xfer-\d+$/);
    expect(transfersSrc).toMatch(/`xfer-\$\{sessionWindowId\(\)\}-\$\{nextId\+\+\}`/);
  });
});

describe("wire literals, pinned in both casings", () => {
  test("the frame type and its fields are spelled exactly once each", () => {
    expect(typesSrc).toMatch(/type: "transfer_queue";/);
    expect(typesSrc).toMatch(/window_id: string;/);
    expect(typesSrc).toMatch(/transfer_id: string;/);
    expect(typesSrc).toMatch(/state: "waiting" \| "active";/);
    expect(typesSrc).toMatch(/position\?: number;/);
  });

  test("the store routes the frame by its exact discriminator", () => {
    expect(storeSrc).toMatch(/frameType === "transfer_queue"/);
    expect(storeSrc).toMatch(/applyTransferQueueFrame\(/);
  });

  test("the request headers are the contract's exact lowercase names", () => {
    expect(clientSrc).toMatch(/"x-chan-window-id"/);
    expect(clientSrc).toMatch(/"x-chan-transfer-id"/);
    // Camel/snake variants of the wire names must not appear at all.
    expect(clientSrc).not.toMatch(/xChanWindowId|x_chan_window_id/);
    expect(clientSrc).not.toMatch(/xChanTransferId|x_chan_transfer_id/);
  });

  test("both headers travel together or not at all", () => {
    expect(clientSrc).toMatch(
      /if \(opts\.transferId\) \{[\s\S]{1,240}"x-chan-window-id"[\s\S]{1,160}"x-chan-transfer-id"/,
    );
  });

  test("the two tracked upload call sites pass their transfer id", () => {
    // The only transfers the browser can make tracked. Anchor downloads and
    // native desktop transfers cannot carry headers and stay untracked.
    expect(storeSrc).toMatch(/api\.replaceFile\([\s\S]{1,200}transferId: xferId,/);
    expect(storeSrc).toMatch(/api\.uploadFile\([\s\S]{1,200}transferId: xferId,/);
  });
});

describe("the admission refusal is not a failure", () => {
  test("a 503 is raised as busy with its retry interval, before any body is read", () => {
    expect(clientSrc).toMatch(/response\.status === 503/);
    expect(clientSrc).toMatch(/retryAfterSeconds: response\.retryAfterSeconds/);
    expect(clientSrc).toMatch(/"server busy"/);
  });

  test("a missing Retry-After stays absent rather than becoming zero", () => {
    // Number(null) and Number("") are both 0, which would read as "retry now".
    expect(clientSrc).toMatch(/if \(!trimmed\) return null;/);
    expect(clientSrc).toMatch(/Number\.isFinite\(seconds\) \? seconds : null/);
  });

  test("the header is read only on a refusal, and cannot strand the promise", () => {
    // Reading it unconditionally threw inside onload against a response object
    // that models no headers, which left the upload promise unsettled and the
    // caller waiting rather than failing.
    expect(clientSrc).toMatch(
      /xhr\.status === 503[\s\S]{1,120}xhr\.getResponseHeader\?\.\("retry-after"\)/,
    );
  });
});

describe("assumptions this build makes about the open contract point", () => {
  test("no terminal frame: the record settles on the HTTP response, not a frame", () => {
    // The server has not fixed whether completion or cancellation emits a
    // final frame; it leans to no. If that changes, this test fails and the
    // browser half gets revisited, rather than drifting silently.
    resetTransfers();
    const id = begin();
    applyTransferQueueFrame({ transfer_id: id, state: "active" });
    finishTransfer(id);
    expect(transfers.items[0]!.state).toBe("done");
    expect(transfers.items[0]!.queue).toBeNull();
  });
});
