// @vitest-environment jsdom
//
// A terminal dragged to another window arrives with the state a reload of the
// same tab would restore. The move crosses a process boundary, so it has to
// serialize: the payload carries the session snapshot the reload path already
// writes, and the target rebuilds through the same restore code. Everything
// that does not arrive is named in the decision table beside the payload
// builder, and every name is asserted here so a field cannot go missing in
// silence.
//
// The target may also be an older build that sends no snapshot, which still
// has to reattach the shell on the five fields the payload has always carried.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import Pane from "./Pane.svelte";
import { createTerminalKeyboardProtocolState } from "../terminal/keymap";
import { isRichPromptVisible, showRichPromptForTab } from "../state/richPrompt.svelte";
import { defaultTeamConfig } from "../state/teamDialog.svelte";
import {
  cancelPaneMode,
  findTeamWorkPendingLead,
  layout,
  reattachTerminalInPane,
  type LeafNode,
  type SerTab,
  type TerminalTab,
} from "../state/tabs.svelte";

const CROSS_TAB_MIME = "application/x-chan-tab+json";
const SOURCE_PANE = "pane-move-source";
const TARGET_PANE = "pane-move-target";

const mounted: Array<Record<string, any>> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as any;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as any;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
});

class FakeDataTransfer {
  store = new Map<string, string>();
  effectAllowed = "";
  dropEffect = "";
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? "";
  }
  get types(): string[] {
    return [...this.store.keys()];
  }
  setDragImage(): void {}
}

/// A terminal carrying every optional field the type allows, each with a
/// value that is not the field's default, so a field the move loses shows up
/// as a difference rather than as a coincidence.
function loadedTerminalTab(): TerminalTab {
  const keyboardProtocol = createTerminalKeyboardProtocolState();
  keyboardProtocol.xtermModifyOtherKeys = 2;
  keyboardProtocol.kitty.mainFlags = 1;
  return {
    kind: "terminal",
    id: "term-loaded",
    title: "worker",
    createdAt: 7,
    broadcastEnabled: true,
    broadcastTargetIds: ["term-other"],
    terminalEnvTabName: "spawn-name",
    terminalEnvTabGroup: "spawn-group",
    terminalEnvNamePromptDismissed: true,
    terminalEnvPromptDismissedFor: "spawn-name",
    terminalMetadataDraft: { name: "draft", group: "draft-group" },
    terminalMetadataPending: { name: "pending", group: "pending-group" },
    terminalMetadataError: "rename rejected",
    terminalSessionId: "sess-1",
    submitAgent: "claude",
    controlledTerminal: true,
    terminalActivity: true,
    terminalActivityPulsing: true,
    queueDepth: 3,
    pendingPrompt: { id: "prompt-1", phase: "queued", depth: 1 },
    cwd: "/work",
    seedInput: "echo hi",
    spawnCommand: "bash -l",
    spawnEnv: { CHAN_AGENT: "claude" },
    profile: "fish",
    pendingGlobalName: true,
    richPromptDraftPath: ".chan/drafts/worker/draft.md",
    richPromptCaret: { from: 2, to: 5 },
    richPromptHeight: 240,
    group: "ops",
    keyboardProtocol,
    teamWorkPending: defaultTeamConfig(),
  } satisfies Required<TerminalTab>;
}

/// Drag the source pane's only tab and return what the drag put on the wire.
/// The payload comes out of a real Pane render, so it is the object a second
/// window would receive and not a hand-built stand-in.
async function dragPayload(tab: TerminalTab): Promise<Record<string, any>> {
  const pane: LeafNode = {
    kind: "leaf",
    id: SOURCE_PANE,
    tabs: [tab],
    activeTabId: tab.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const livePane = layout.nodes[pane.id];
  if (livePane?.kind !== "leaf") throw new Error("expected leaf");
  const component = mount(Pane, { target, props: { pane: livePane } });
  mounted.push(component);
  await tick();
  const tabEl = target.querySelector<HTMLElement>('[draggable="true"]');
  expect(tabEl, "the terminal tab renders draggable").not.toBeNull();
  const dt = new FakeDataTransfer();
  const event = new Event("dragstart", { bubbles: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dt });
  tabEl!.dispatchEvent(event);
  const raw = dt.getData(CROSS_TAB_MIME);
  expect(raw, "the terminal offers a cross-window payload").not.toBe("");
  return JSON.parse(raw);
}

/// Stand in for the receiving window: an empty pane the payload lands in.
function emptyTargetPane(): LeafNode {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  const pane: LeafNode = {
    kind: "leaf",
    id: TARGET_PANE,
    tabs: [],
    activeTabId: null,
  };
  layout.nodes = { [pane.id]: pane };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  // Read it back through `layout`: it is $state, so the stored node is a
  // reactive proxy and the literal above is not what the reattach mutates.
  return layout.nodes[pane.id] as LeafNode;
}

/// Source window drag, then target window drop, for a tab holding everything.
async function moveLoadedTerminal(): Promise<{
  payload: Record<string, any>;
  pane: LeafNode;
  moved: TerminalTab;
}> {
  const source = loadedTerminalTab();
  showRichPromptForTab(source.id);
  const payload = await dragPayload(source);
  const pane = emptyTargetPane();
  const moved = reattachTerminalInPane(pane.id, {
    terminalSessionId: payload.terminalSessionId,
    title: payload.title,
    terminalEnvTabName: payload.terminalEnvTabName,
    group: payload.group,
    cwd: payload.cwd,
    ser: payload.ser as SerTab | undefined,
  });
  expect(moved, "the target rebuilds the terminal").not.toBeNull();
  return { payload, pane, moved: moved as TerminalTab };
}

describe("a terminal moved to another window keeps its tab state", () => {
  test("the payload carries the session snapshot, not five fields", async () => {
    const payload = await dragPayload(loadedTerminalTab());

    expect(payload.kind).toBe("terminal");
    expect(payload.terminalSessionId).toBe("sess-1");
    // The snapshot is the transport for everything the five fields never
    // covered; without it the target has nothing to rebuild from.
    expect(payload.ser).toBeTruthy();
  });

  test("every field the contract carries arrives in the target window", async () => {
    const { moved } = await moveLoadedTerminal();

    expect(moved.kind).toBe("terminal");
    expect(moved.title).toBe("worker");
    expect(moved.terminalSessionId).toBe("sess-1");
    expect(moved.terminalEnvTabName).toBe("spawn-name");
    expect(moved.group).toBe("ops");
    expect(moved.cwd).toBe("/work");
    expect(moved.profile).toBe("fish");
    expect(moved.controlledTerminal).toBe(true);
    expect(moved.richPromptDraftPath).toBe(".chan/drafts/worker/draft.md");
    expect(moved.richPromptCaret).toEqual({ from: 2, to: 5 });
    expect(moved.richPromptHeight).toBe(240);
    expect(moved.teamWorkPending).toEqual(defaultTeamConfig());
    // The negotiated protocol travels as the reload snapshot: the flags the
    // running program announced, which is what keeps Shift+Enter a newline.
    // The push/pop stacks are not in the snapshot and are not claimed here.
    expect(moved.keyboardProtocol?.xtermModifyOtherKeys).toBe(2);
    expect(moved.keyboardProtocol?.kitty.mainFlags).toBe(1);
    // A queued Rich Prompt message is actionable only with the bubble showing,
    // so the visibility travels with it exactly as a reload restores it.
    expect(moved.pendingPrompt).toEqual({ id: "prompt-1", phase: "queued" });
    expect(isRichPromptVisible(moved.id)).toBe(true);
  });

  test("each deliberate drop is absent by name", async () => {
    const { moved } = await moveLoadedTerminal();

    // A fresh identity in the receiving window: the id is minted there so a
    // move cannot collide with a tab already live, and the timestamp is when
    // this window built the tab.
    expect(moved.id).not.toBe("term-loaded");
    expect(moved.createdAt).not.toBe(7);
    // Broadcast membership is this window's fan-out state, rebuilt from the
    // roster, and the rest below is either server-owned and refreshed by the
    // attach prelude or a one-shot the source already consumed.
    expect(moved.broadcastEnabled).toBe(false);
    expect(moved.broadcastTargetIds).toEqual([]);
    expect(moved.terminalEnvTabGroup).toBeUndefined();
    expect(moved.terminalEnvNamePromptDismissed).toBeUndefined();
    expect(moved.terminalEnvPromptDismissedFor).toBeUndefined();
    expect(moved.terminalMetadataDraft).toBeUndefined();
    expect(moved.terminalMetadataPending).toBeUndefined();
    expect(moved.terminalMetadataError).toBeUndefined();
    expect(moved.submitAgent).toBeUndefined();
    expect(moved.terminalActivity).toBeUndefined();
    expect(moved.terminalActivityPulsing).toBeUndefined();
    expect(moved.queueDepth).toBeUndefined();
    expect(moved.seedInput).toBeUndefined();
    expect(moved.spawnCommand).toBeUndefined();
    expect(moved.spawnEnv).toBeUndefined();
    expect(moved.pendingGlobalName).toBeUndefined();
  });

  test("the wire carries no spawn environment", async () => {
    // `spawnEnv` is dropped because a member's env can hold secrets, so the
    // drop has to happen before the payload leaves this window, not on the
    // way back in.
    const payload = await dragPayload(loadedTerminalTab());

    expect(JSON.stringify(payload)).not.toContain("CHAN_AGENT");
    expect(JSON.stringify(payload)).not.toContain("bash -l");
  });

  test("a Team Work lead still reads as one after the move", async () => {
    const { pane, moved } = await moveLoadedTerminal();

    // The field the Team Work surface reads: the dialog relocates its lead
    // through this lookup, and the tab ids regenerate on a move.
    expect(findTeamWorkPendingLead()).toEqual({
      leadTabId: moved.id,
      leadPaneId: pane.id,
    });
  });

  test("a payload with no snapshot reattaches on the five older fields", () => {
    // A peer window on an older build sends no `ser`. The shell still has to
    // arrive, on exactly what that build sends.
    const pane = emptyTargetPane();

    const moved = reattachTerminalInPane(pane.id, {
      terminalSessionId: "sess-old",
      title: "legacy",
      terminalEnvTabName: "legacy-spawn",
      group: "ops",
      cwd: "/legacy",
    });

    expect(moved).not.toBeNull();
    expect(moved?.terminalSessionId).toBe("sess-old");
    expect(moved?.title).toBe("legacy");
    expect(moved?.terminalEnvTabName).toBe("legacy-spawn");
    expect(moved?.group).toBe("ops");
    expect(moved?.cwd).toBe("/legacy");
    // Nothing is invented for the fields that build never sent.
    expect(moved?.profile).toBeUndefined();
    expect(moved?.richPromptDraftPath).toBeUndefined();
    expect(moved?.teamWorkPending).toBeUndefined();
    expect(pane.tabs).toHaveLength(1);
    expect(pane.activeTabId).toBe(moved?.id);
  });

  test("a snapshot naming another kind reattaches the shell instead of throwing", () => {
    // Defensive on the same boundary: a peer build could send a snapshot this
    // one does not read as a terminal. The shell is what must not be lost.
    const pane = emptyTargetPane();

    const moved = reattachTerminalInPane(pane.id, {
      terminalSessionId: "sess-odd",
      title: "odd",
      ser: { k: "z" } as unknown as SerTab,
    });

    expect(moved).not.toBeNull();
    expect(moved?.terminalSessionId).toBe("sess-odd");
    expect(moved?.title).toBe("odd");
  });
});
