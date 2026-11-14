// @vitest-environment jsdom
//
// How a terminal carries its Rich Prompt: the prompt sink that sends `prompt`
// frames (a team lead's identity prompt among them), the queue and delivery
// frames that drive the tab's badge and the pending card, the draft's cleanup
// on close, and the doors that open the composer. A TerminalTab is mounted over the stand-in xterm and socket; the
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
      createDraft: vi.fn(async () => ({ path: draftPath("rp") })),
      read: vi.fn(async () => ({ content: "" })),
      write: vi.fn(async () => ({})),
      discardDraft: vi.fn(async () => {}),
    },
  };
});

import Pane from "./Pane.svelte";
import TerminalTab from "./TerminalTab.svelte";
import { api } from "../api/client";
import { allCommands, commandContext } from "../state/commands";
import "../state/commands/install";
import {
  isRichPromptToolbarOpen,
  isRichPromptVisible,
  richPrompt,
  setRichPromptToolbarOpen,
  showRichPromptForTab,
} from "../state/richPrompt.svelte";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import { chordFor } from "../state/shortcuts";
import {
  allTerminalTabs,
  beginPendingPrompt,
  closeTab,
  layout,
  markTerminalMovingOut,
  sendPromptToTerminal,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import { runTeamBootstrap } from "../state/teamOrchestrator.svelte";
import { workspace } from "../state/workspace.svelte";
import type { WorkspaceInfo } from "../api/types";
import { ownershipWarnings } from "../__tests__/svelteWarnings";
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
import { draftPath } from "../__tests__/drafts";

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
  richPrompt.toolbarByTab = {};
  richPrompt.sourceByTab = {};
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

  // The team dialog's bootstrap spawns the lead, opens its terminal and sends
  // the identity prompt through that terminal's prompt sink. The server reads
  // an omitted agent as claude, so the frame names the lead's agent.
  async function bootstrapTeamAndMountLead(command: string, env: string) {
    seatTerminals([terminalTab({ id: "placeholder" })]);
    await runTeamBootstrap(
      {
        hostName: "Neo",
        configMode: "new",
        teamDir: "team",
        tabGroup: "team",
        size: 2,
        autoPrefix: true,
        mcpEnv: false,
        members: [
          { name: "Lead", command, env, isLead: true },
          { name: "Worker", command: "claude", env: "", isLead: false },
        ],
        realEstate: { kind: "tabs" },
        brief: "",
      },
      { leadTabId: "placeholder", leadPaneId: TERMINAL_PANE },
    );
    const lead = allTerminalTabs().find((t) => t.title === "@@Lead")!;
    await mountTerminal(TerminalTab, lead);
    return { lead, socket: TerminalSocket.all.at(-1)! };
  }

  async function withTeamApi(run: () => Promise<void>): Promise<void> {
    const root = workspace.info;
    workspace.info = { root: "/ws" } as unknown as WorkspaceInfo;
    const write = vi.spyOn(api, "writeTeamConfig").mockResolvedValue(undefined);
    const spawn = vi.spyOn(api, "spawnTerminal").mockImplementation(async (request) => ({
      session: `session-${request.name}`,
      tab_label: request.name ?? "",
    }));
    try {
      await run();
    } finally {
      write.mockRestore();
      spawn.mockRestore();
      workspace.info = root;
    }
  }

  for (const [command, agent] of [
    ["codex", "codex"],
    ["claude --resume", "claude"],
  ] as const) {
    test(`a team lead running ${command} gets its identity prompt with agent ${agent}`, async () => {
      await withTeamApi(async () => {
        const { socket } = await bootstrapTeamAndMountLead(command, "");
        const prompts = () => sentFrames(socket).filter((f) => f.type === "prompt");
        await vi.waitFor(() => expect(prompts()).toHaveLength(1), { timeout: 5000, interval: 50 });
        expect(prompts()[0]!.agent).toBe(agent);
        expect(prompts()[0]!.data).toContain("/ws/team/bootstrap.md");
      });
    });
  }

  // A lead chan does not recognise as an agent has no compose box: text sent
  // to it lands at a shell prompt, and each line runs as a command the user
  // never typed. The bootstrap sends it nothing. The orchestrator retries a
  // send every 250 ms until the lead's socket takes it, so the window below
  // spans several retries after the socket opened.
  for (const [command, env] of [
    ["bash", ""],
    ["aider --model test", ""],
    ["claude", "CHAN_AGENT=none"],
  ] as const) {
    test(`a team lead running ${command}${env ? ` with ${env}` : ""} is sent nothing`, async () => {
      await withTeamApi(async () => {
        const { lead, socket } = await bootstrapTeamAndMountLead(command, env);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const written = sentFrames(socket).filter((f) =>
          ["prompt", "input", "broadcast-input"].includes(f.type as string),
        );
        expect(written).toEqual([]);
        // The lead's sink was live all along, so a send would have landed.
        expect(sendPromptToTerminal(lead.id, "probe", "none")).toBe(true);
        expect(sentFrames(socket).filter((f) => f.type === "prompt")).toEqual([
          { type: "prompt", data: "probe", agent: "none" },
        ]);
      });
    });
  }
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
    const { tab } = await attached({ richPromptDraftPath: draftPath("rp") });
    richPrompt.byTab[tab.id] = true;
    // Forced, as the close chord does: a live terminal otherwise asks first.
    await closeTab(TERMINAL_PANE, tab.id, { force: true });
    expect(api.discardDraft).toHaveBeenCalledWith(draftPath("rp"));
    expect(isRichPromptVisible(tab.id)).toBe(false);
  });

  test("keeps the draft when the terminal moves to another window, whose tab names it", async () => {
    const { tab } = await attached({ richPromptDraftPath: draftPath("rp") });
    markTerminalMovingOut(tab.id);
    await closeTab(TERMINAL_PANE, tab.id, { force: true });
    expect(api.discardDraft).not.toHaveBeenCalled();
  });

  test("keeps the draft when a terminal whose shell exited moves", async () => {
    const { tab, socket } = await attached({ richPromptDraftPath: draftPath("rp") });
    await receive(socket, { type: "exit", code: 0 });
    expect(tab.terminalSessionId, "the exit cleared the session").toBeUndefined();
    markTerminalMovingOut(tab.id);
    await closeTab(TERMINAL_PANE, tab.id, { force: true });
    expect(api.discardDraft).not.toHaveBeenCalled();
  });

  test("forgets its composer's style toolbar", async () => {
    const { tab } = await attached();
    setRichPromptToolbarOpen(tab.id, true);
    await closeTab(TERMINAL_PANE, tab.id, { force: true });
    expect(tab.id in richPrompt.toolbarByTab).toBe(false);
  });
});

/// The catalog's title for `id`, failing on an id nothing registers.
function title(id: string): string {
  const command = allCommands().find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  return command.title;
}

/// The open menu's row for the toggle `id`: whether it is there, and
/// whether it announces and draws its check.
function toggleRow(id: string): { row: HTMLButtonElement; on: boolean } | null {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
    (b) => b.querySelector(".mbtn-label")?.textContent?.trim() === title(id),
  );
  if (!row) return null;
  expect(row.getAttribute("role"), id).toBe("menuitemcheckbox");
  const on = row.getAttribute("aria-checked") === "true";
  expect(row.querySelector(".mbtn-icon svg") !== null, `${id} draws its check`).toBe(on);
  return { row, on };
}

describe("the doors to the composer", () => {
  const PROMPT = "terminal.richPrompt";
  const TOOLBAR = "terminal.richPromptToolbar";

  test("the body menu's row names the chord the keymap holds when it opens", async () => {
    const { target } = await attached();
    const before = chordFor(PROMPT);
    assignOverride(PROMPT, "Mod+Alt+J");
    try {
      const rebound = chordFor(PROMPT);
      expect(rebound, "the override took").not.toBe(before);
      await openBodyMenu(target);
      expect(menuRow(title(PROMPT)).querySelector(".mbtn-chord")?.textContent, "the rebound chord").toBe(rebound);
    } finally {
      clearOverride(PROMPT);
    }
  });

  test("the body menu's row is the command's title with a check while it shows, and names the chord", async () => {
    const { tab, target } = await attached();
    const labels = await openBodyMenu(target);
    expect(labels).toContain("Rich Prompt");
    const closed = toggleRow(PROMPT)!;
    expect(closed.on).toBe(false);
    expect(closed.row.querySelector(".mbtn-chord")?.textContent).toBe(chordFor(PROMPT) ?? "");
    closed.row.click();
    await tick();
    expect(isRichPromptVisible(tab.id)).toBe(true);

    await openBodyMenu(target);
    const open = toggleRow(PROMPT)!;
    expect(open.on).toBe(true);
    open.row.click();
    await tick();
    expect(isRichPromptVisible(tab.id)).toBe(false);
  });

  test("a composer opened on a terminal without a draft records the draft it creates", async () => {
    const warnings = ownershipWarnings();
    const { tab } = await attached();

    showRichPromptForTab(tab.id);
    await vi.waitFor(() => expect(tab.richPromptDraftPath).toBe(draftPath("rp")));
    expect(api.createDraft).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([]);
  });

  test("a window without a drafts store offers no menu row", async () => {
    caps.drafts = false;
    const { target } = await attached();
    const labels = await openBodyMenu(target);
    expect(labels.some((l) => l.includes("Rich Prompt"))).toBe(false);
  });

  test("the body menu offers the style toolbar's row only while the composer shows, worded and checked by its command", async () => {
    const { tab, target } = await attached();
    await openBodyMenu(target);
    expect(toggleRow(TOOLBAR)).toBeNull();

    showRichPromptForTab(tab.id);
    await tick();
    // With the composer showing the menu holds its two rows, the toolbar's
    // after the composer's own.
    const labels = await openBodyMenu(target);
    expect(labels.slice(labels.indexOf(title(PROMPT)), labels.indexOf(title(PROMPT)) + 2)).toEqual([
      "Rich Prompt",
      "Rich Prompt style toolbar",
    ]);
    const closed = toggleRow(TOOLBAR)!;
    expect(closed.on).toBe(false);
    closed.row.click();
    await tick();
    expect(isRichPromptToolbarOpen(tab.id)).toBe(true);

    await openBodyMenu(target);
    const open = toggleRow(TOOLBAR)!;
    expect(open.on).toBe(true);
    open.row.click();
    await tick();
    expect(isRichPromptToolbarOpen(tab.id)).toBe(false);
  });

  test("the launcher's style toolbar command is offered only while the composer shows", async () => {
    const { tab } = await attached();
    const command = allCommands().find((c) => c.id === "terminal.richPromptToolbar")!;
    expect(command).toMatchObject({ title: "Rich Prompt style toolbar", category: "Terminal", requirement: "drafts" });
    expect(command.available?.(commandContext())).toBe(false);

    showRichPromptForTab(tab.id);
    expect(command.available?.(commandContext())).toBe(true);
    await command.run();
    expect(isRichPromptToolbarOpen(tab.id)).toBe(true);
    await command.run();
    expect(isRichPromptToolbarOpen(tab.id)).toBe(false);
  });

  test("the launcher's command asks the app to toggle it", async () => {
    const command = allCommands().find((c) => c.id === "terminal.richPrompt")!;
    expect(command).toMatchObject({ title: "Rich Prompt", category: "Terminal", requirement: "drafts" });
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail?.name);
    window.addEventListener("chan:command", listener);
    await command.run();
    window.removeEventListener("chan:command", listener);
    expect(heard).toEqual(["terminal.richPrompt"]);
  });
});

describe("the composer's pending card", () => {
  /// A terminal with its composer open over a loaded draft, so the composer
  /// is the one that settles the pending message.
  async function withComposer() {
    const at = await attached();
    showRichPromptForTab(at.tab.id);
    await vi.waitFor(() => expect(at.tab.richPromptDraftPath).toBe(draftPath("rp")));
    await vi.waitFor(() => expect(document.querySelector(".rich-prompt .cm-content")).not.toBeNull());
    return at;
  }

  test("a delivery clears the tab's pending message without an ownership warning", async () => {
    const warnings = ownershipWarnings();
    const { tab, socket } = await withComposer();

    beginPendingPrompt(tab, "m-1");
    await receive(socket, { type: "prompt-delivered", id: "m-1", depth: 0 });
    await vi.waitFor(() => expect(tab.pendingPrompt).toBeUndefined());
    expect(warnings()).toEqual([]);
  });

  test("an acknowledged cancel clears the tab's pending message without an ownership warning", async () => {
    const warnings = ownershipWarnings();
    const { tab, socket } = await withComposer();

    beginPendingPrompt(tab, "m-1");
    await tick();
    const cancel = document.querySelector<HTMLButtonElement>(".rich-prompt .rp-primary")!;
    expect(cancel.textContent?.trim()).toBe("esc cancel");
    cancel.click();
    await receive(socket, { type: "prompt-cancelled", id: "m-1", removed: true });
    await tick();
    expect(tab.pendingPrompt).toBeUndefined();
    expect(warnings()).toEqual([]);
  });
});
