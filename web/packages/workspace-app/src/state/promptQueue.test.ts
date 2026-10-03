// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
  beginPendingPrompt,
  beginPromptRecall,
  failPendingPrompt,
  resolvePendingPrompt,
  resolvePromptCancelled,
  setTerminalQueueDepth,
  type TerminalTab,
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
  test("rejection settles recall with its text while queue and delivery wait", () => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    beginPromptRecall(tab, "msg-1", "keep this refused prompt");
    const recalling = { id: "msg-1", phase: "recalling", recallText: "keep this refused prompt" };

    resolvePendingPrompt(tab, "msg-1", "queued", 1);
    expect(tab.pendingPrompt).toEqual(recalling);
    resolvePendingPrompt(tab, "msg-1", "delivered", 0);
    expect(tab.pendingPrompt).toEqual(recalling);

    resolvePendingPrompt(tab, "msg-1", "rejected", 100);
    expect(tab.pendingPrompt).toEqual({ ...recalling, phase: "rejected", depth: 100 });
  });

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

  // The bubble consumes a terminal phase only once its draft is loaded, so
  // one can stand on the tab when the cancellation's answer arrives.
  const TERMINAL: [what: string, phase: string, settle: (tab: TerminalTab) => void][] = [
    [
      "a refusal of a recalled prompt",
      "rejected",
      (tab) => {
        beginPromptRecall(tab, "msg-1", "keep this refused prompt");
        resolvePendingPrompt(tab, "msg-1", "rejected", 100);
      },
    ],
    [
      "a failed recall",
      "failed",
      (tab) => {
        beginPromptRecall(tab, "msg-1", "keep this prompt");
        failPendingPrompt(tab);
      },
    ],
    [
      "a delivery",
      "delivered",
      (tab) => {
        resolvePendingPrompt(tab, "msg-1", "queued", 1);
        resolvePendingPrompt(tab, "msg-1", "delivered", 0);
      },
    ],
  ];

  test.each(TERMINAL)("a cancellation's answer leaves %s the bubble has not consumed", (_what, phase, settle) => {
    const tab = terminalTab();
    beginPendingPrompt(tab, "msg-1");
    settle(tab);
    const settled = { ...tab.pendingPrompt };
    resolvePromptCancelled(tab, "msg-1", false);
    const afterNotRemoved = tab.pendingPrompt?.phase;
    resolvePromptCancelled(tab, "msg-1", true);

    expect({ afterNotRemoved, afterRemoved: tab.pendingPrompt?.phase }).toEqual({
      afterNotRemoved: phase,
      afterRemoved: phase,
    });
    expect(tab.pendingPrompt).toEqual(settled);
  });

  const IN_FLIGHT: [phase: string, reach: (tab: TerminalTab) => void][] = [
    ["sent", () => {}],
    ["queued", (tab) => resolvePendingPrompt(tab, "msg-1", "queued", 1)],
    ["recalling", (tab) => beginPromptRecall(tab, "msg-1", "take this back")],
  ];

  test.each(IN_FLIGHT)("a cancellation's answer settles a prompt still %s", (phase, reach) => {
    const answered = [true, false].map((removed) => {
      const tab = terminalTab();
      beginPendingPrompt(tab, "msg-1");
      reach(tab);
      const before = tab.pendingPrompt?.phase;
      resolvePromptCancelled(tab, "msg-1", removed);
      return { before, after: tab.pendingPrompt?.phase };
    });

    expect(answered).toEqual([
      { before: phase, after: "recalled" },
      { before: phase, after: "drained" },
    ]);
  });
});
