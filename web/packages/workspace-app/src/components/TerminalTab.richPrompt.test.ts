// @vitest-environment jsdom
//
// How a terminal carries its Rich Prompt: the prompt sink that sends `prompt`
// frames, the queue and delivery frames that drive the tab's badge and the
// pending card, the draft's cleanup on close, and the doors that open the
// composer. A TerminalTab is mounted over the stand-in xterm and socket; the
// window's drafts capability is stubbed so a test can take it away.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ drafts: true }));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: {
    workspace: true,
    files: true,
    get drafts() {
      return caps.drafts;
    },
    terminal: true,
  },
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createDraft: vi.fn(async () => ({ path: ".Drafts/rp/draft.md" })),
      read: vi.fn(async () => ({ content: "" })),
      write: vi.fn(async () => ({})),
      discardDraft: vi.fn(async () => {}),
    },
  };
});

import Pane from "./Pane.svelte";
import TerminalTab from "./TerminalTab.svelte";
import { api } from "../api/client";
import { allCommands } from "../state/commands";
import "../state/commands/install";
import { isRichPromptVisible, richPrompt } from "../state/richPrompt.svelte";
import { chordFor } from "../state/shortcuts";
import {
  beginPendingPrompt,
  closeTab,
  layout,
  sendPromptToTerminal,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

beforeEach(() => {
  caps.drafts = true;
  // The composer's editor measures on animation frames; the harness's
  // synchronous frame would run those measures inside an update.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterEach(() => {
  resetTerminals();
  richPrompt.byTab = {};
  vi.clearAllMocks();
});

async function attached(over: Partial<TerminalTabState> = {}, prelude: Record<string, unknown> = {}) {
  const [tab] = seatTerminals([terminalTab(over)]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, prelude);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  socket.sent.splice(0);
  return { ...mounted, tab: tab!, socket };
}

describe("the prompt sink", () => {
  test("sends a prompt frame, with the agent and id when given, and never raw input", async () => {
    const { tab, socket } = await attached();
    expect(sendPromptToTerminal(tab.id, "run it", "claude", "m-1")).toBe(true);
    expect(sendPromptToTerminal(tab.id, "plain")).toBe(true);

    expect(sentFrames(socket)).toEqual([
      { type: "prompt", data: "run it", agent: "claude", id: "m-1" },
      { type: "prompt", data: "plain" },
    ]);
  });
});

describe("the queue frames", () => {
  test("set the tab's queue depth outright, as the server counts it", async () => {
    const { tab, socket } = await attached();
    await receive(socket, { type: "queue", depth: 3 });
    expect(tab.queueDepth).toBe(3);
    await receive(socket, { type: "queue", depth: 0 });
    expect(tab.queueDepth ?? 0).toBe(0);
  });

  test("an ack resolves the pending message as queued or rejected, a delivery as delivered", async () => {
    const { tab, socket } = await attached();
    for (const [frame, phase] of [
      [{ type: "prompt-ack", id: "m-1", queued: true, depth: 1 }, "queued"],
      [{ type: "prompt-ack", id: "m-1", queued: false, depth: 0 }, "rejected"],
      [{ type: "prompt-delivered", id: "m-1", depth: 0 }, "delivered"],
    ] as const) {
      beginPendingPrompt(tab, "m-1");
      await receive(socket, frame);
      expect(tab.pendingPrompt?.phase, frame.type).toBe(phase);
    }
  });

  test("an attach takes the queue depth and the submit agent from the session prelude", async () => {
    const { tab } = await attached({}, { queue_depth: 2, submit_agent: "codex" });
    expect(tab.queueDepth).toBe(2);
    expect(tab.submitAgent).toBe("codex");
  });

  test("a lost socket fails the pending message and zeroes the badge", async () => {
    const { tab, socket } = await attached({}, { queue_depth: 2 });
    beginPendingPrompt(tab, "m-1");
    socket.close();
    expect(tab.pendingPrompt?.phase).toBe("failed");
    expect(tab.queueDepth ?? 0).toBe(0);
  });

  for (const end of [{ type: "closed" }, { type: "exit", code: 0 }]) {
    test(`a ${end.type} frame fails the pending message, zeroes the badge and ends the session`, async () => {
      const { tab, socket } = await attached({}, { queue_depth: 2 });
      beginPendingPrompt(tab, "m-1");
      await receive(socket, end);
      expect(tab.pendingPrompt?.phase).toBe("failed");
      expect(tab.queueDepth ?? 0).toBe(0);
      expect(tab.terminalSessionId).toBeUndefined();
    });
  }
});

describe("the tab strip", () => {
  test("shows a queued-messages pill on a terminal tab with a queue, and none without", async () => {
    const [tab] = seatTerminals([terminalTab({ queueDepth: 2 })]);
    const target = document.createElement("div");
    document.body.append(target);
    const pane = mount(Pane, { target, props: { pane: layout.nodes[TERMINAL_PANE] as LeafNode } });
    await tick();
    const pill = () => target.querySelector<HTMLElement>(".queue-pill");
    expect(pill()?.textContent).toBe("2");
    expect(pill()?.title).toBe("queued terminal messages");

    tab!.queueDepth = undefined;
    await tick();
    expect(pill()).toBeNull();
    unmount(pane);
  });
});

describe("closing the terminal", () => {
  test("discards its Rich Prompt draft and forgets its composer", async () => {
    const { tab } = await attached({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    richPrompt.byTab[tab.id] = true;
    // Forced, as the close chord does: a live terminal otherwise asks first.
    await closeTab(TERMINAL_PANE, tab.id, { force: true });
    expect(api.discardDraft).toHaveBeenCalledWith(".Drafts/rp/draft.md");
    expect(isRichPromptVisible(tab.id)).toBe(false);
  });
});

describe("the doors to the composer", () => {
  test("the body menu's row shows or hides it and names the chord", async () => {
    const { tab, target } = await attached();
    const labels = await openBodyMenu(target);
    expect(labels).toContain("Show Rich Prompt");
    const row = menuRow("Show Rich Prompt");
    expect(row.querySelector(".mbtn-chord")?.textContent).toBe(chordFor("terminal.richPrompt") ?? "");
    row.click();
    await tick();
    expect(isRichPromptVisible(tab.id)).toBe(true);

    expect(await openBodyMenu(target)).toContain("Hide Rich Prompt");
  });

  test("a window without a drafts store offers no menu row", async () => {
    caps.drafts = false;
    const { target } = await attached();
    const labels = await openBodyMenu(target);
    expect(labels.some((l) => l.endsWith("Rich Prompt"))).toBe(false);
  });

  test("the launcher's command asks the app to toggle it", async () => {
    const command = allCommands().find((c) => c.id === "terminal.richPrompt")!;
    expect(command).toMatchObject({ title: "Show/Hide Rich Prompt", category: "Terminal", requirement: "drafts" });
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail?.name);
    window.addEventListener("chan:command", listener);
    await command.run();
    window.removeEventListener("chan:command", listener);
    expect(heard).toEqual(["terminal.richPrompt"]);
  });
});
