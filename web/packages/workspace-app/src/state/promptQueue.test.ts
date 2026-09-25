// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
  beginPendingPrompt,
  failPendingPrompt,
  resolvePendingPrompt,
  setTerminalQueueDepth,
} from "./tabs.svelte";
import { terminalTab } from "../__tests__/tabs";

// Rich Prompt queue visibility -- the tab-level state machine the WS frame
// handler (TerminalTab.svelte) and the bubble (RichPrompt.svelte) share.
// The frames and the markup are driven in TerminalTab.richPrompt.test.ts and
// RichPrompt.svelte.test.ts; this exercises the store transitions.

describe("terminal queue depth", () => {
  // The store setter takes whatever depth the server sent. What the depth
  // MEANS (logical messages, one absolute step per drained batch) is the
  // server's contract, pinned in chan-library; that the handler assigns it
  // instead of adjusting the badge relatively is driven in
  // TerminalTab.richPrompt.test.ts.
  test("positive depths stick; zero collapses to undefined (truthiness renders)", () => {
    const tab = terminalTab();
    setTerminalQueueDepth(tab, 3);
    expect(tab.queueDepth).toBe(3);
    setTerminalQueueDepth(tab, 1);
    expect(tab.queueDepth).toBe(1);
    setTerminalQueueDepth(tab, 0);
    expect(tab.queueDepth).toBeUndefined();
  });
});

describe("a batch does not disturb a pending Rich Prompt", () => {
  test("no prompt-delivered rides a batch, so a queued bubble stays queued", () => {
    // Rich Prompt is a queue boundary and the only tagged message kind, so a
    // batch of untagged notifications emits depth alone. The bubble stays
    // locked until its OWN prompt-delivered arrives.
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    resolvePendingPrompt(tab, "msg-1", "queued", 6);
    setTerminalQueueDepth(tab, 1);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "queued", depth: 6 });
    expect(tab.queueDepth).toBe(1);

    resolvePendingPrompt(tab, "msg-1", "delivered", 0);
    setTerminalQueueDepth(tab, 0);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "delivered", depth: 0 });
    expect(tab.queueDepth).toBeUndefined();
  });
});

describe("pending prompt state machine", () => {
  test("begin -> queued (ack depth = position) -> delivered", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "sent" });

    resolvePendingPrompt(tab, "msg-1", "queued", 2);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "queued", depth: 2 });

    resolvePendingPrompt(tab, "msg-1", "delivered", 1);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "delivered", depth: 1 });
  });

  test("rejected ack (queue full) resolves without losing the id", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    resolvePendingPrompt(tab, "msg-1", "rejected", 100);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "rejected", depth: 100 });
  });

  test("stale/foreign ids no-op: another window's delivered cannot flip my pending", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "mine");
    resolvePendingPrompt(tab, "theirs", "delivered", 0);
    expect(tab.pendingPrompt).toEqual({ id: "mine", phase: "sent" });
    // No pending at all: resolve is a no-op, not a phantom pending.
    const idle = terminalTab();
    resolvePendingPrompt(idle, "ghost", "queued", 1);
    expect(idle.pendingPrompt).toBeUndefined();
  });

  test("failPendingPrompt is unguarded (WS close has no id) but needs a pending", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    resolvePendingPrompt(tab, "msg-1", "queued", 1);
    failPendingPrompt(tab);
    expect(tab.pendingPrompt).toEqual({ id: "msg-1", phase: "failed", depth: 1 });

    const idle = terminalTab();
    failPendingPrompt(idle);
    expect(idle.pendingPrompt).toBeUndefined();
  });

  test("a new begin replaces a leftover resolved pending", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "old");
    failPendingPrompt(tab);
    beginPendingPrompt(tab, "new");
    expect(tab.pendingPrompt).toEqual({ id: "new", phase: "sent" });
  });
});
