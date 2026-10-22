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
// The sending window may also be an older build, whose payload carries no
// snapshot. This window still has to reattach the shell from it, on the five
// fields the payload has always carried.
//
// A terminal with no session, one whose shell exited or that never started,
// moves through the same snapshot and starts a new shell in the target, which
// says what did not move; the source lets it go without asking. Those cases
// drive both ends through the app's own drag handlers.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import Pane from "./Pane.svelte";
import { createTerminalKeyboardProtocolState } from "../terminal/keymap";
import {
  isRichPromptToolbarOpen,
  isRichPromptVisible,
  setRichPromptToolbarOpen,
  showRichPromptForTab,
} from "../state/richPrompt.svelte";
import { defaultTeamConfig } from "../state/teamDialog.svelte";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { ui } from "../state/store.svelte";
import {
  cancelPaneMode,
  findTeamWorkPendingLead,
  isTerminalMoving,
  layout,
  reattachTerminalInPane,
  registerTerminalCloseSink,
  registerTerminalInputSink,
  TERMINAL_MOVE_DECISIONS,
  type LeafNode,
  type SerTab,
  type TerminalTab,
} from "../state/tabs.svelte";

/// The field names the move's decision table marks one way or the other. Read
/// from the table rather than retyped, so flipping a line here is what the
/// assertions below measure.
function fieldsDecided(decision: "carry" | "drop"): string[] {
  return Object.entries(TERMINAL_MOVE_DECISIONS)
    .filter(([, value]) => value === decision)
    .map(([field]) => field)
    .sort();
}

const CROSS_TAB_MIME = "application/x-chan-tab+json";
const SOURCE_PANE = "pane-move-source";
const TARGET_PANE = "pane-move-target";

const mounted: Array<Record<string, any>> = [];
const cleanups: Array<() => void> = [];

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
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
  if (confirmState.open) resolveConfirm(false);
  ui.status = null;
  ui.statusKind = null;
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
    cliCommandPending: true,
    cliReloadNotice: true,
    submitAgent: "claude",
    controlledTerminal: true,
    terminalActivity: true,
    terminalActivityPulsing: true,
    inspectorOpen: true,
    inspectorWidth: 310,
    queueDepth: 3,
    programStatus: {
      revision: 1,
      records: [{ source: "program", id: null, state: "working", kind: null, progress: 0, app: "test", title: null, msg: null, seen: false, update_order: 1 }],
    },
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
  return (await startDrag(tab)).payload;
}

/// Mount the source pane holding `tab` and fire the app's real dragstart on it:
/// what the drag carries, parsed and as the transfer holds it, and the pane.
async function startDrag(
  tab: TerminalTab,
): Promise<{ dt: FakeDataTransfer; payload: Record<string, any>; target: HTMLElement }> {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
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
  return { dt, payload: JSON.parse(raw), target };
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

/// The receiving window's half of the gesture: an empty pane takes the drag on
/// its tab strip through the app's own drop handler. Whether it claimed the
/// drop is what tells the source to let its tab go.
async function dropInTarget(dt: FakeDataTransfer): Promise<{ pane: LeafNode; accepted: boolean }> {
  const pane = emptyTargetPane();
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane } }));
  await tick();
  const drop = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(drop, "dataTransfer", { value: dt });
  target.querySelector<HTMLElement>(".tabs")!.dispatchEvent(drop);
  await tick();
  return { pane, accepted: drop.defaultPrevented };
}

/// What a terminal whose shell exited holds: everything the loaded tab holds
/// but what the exit cleared, its session id and environment name, and the
/// spawn overrides, which go at a session's first frame.
function endedTerminalTab(): TerminalTab {
  const tab: TerminalTab = loadedTerminalTab();
  delete tab.terminalSessionId;
  delete tab.terminalEnvTabName;
  delete tab.spawnCommand;
  delete tab.spawnEnv;
  delete tab.seedInput;
  return tab;
}

/// The fields the table marks carry that a move with no session does not
/// deliver, each with its reason. Every other carried field arrives.
const NOT_ARRIVING_WITHOUT_A_SESSION: Record<string, string> = {
  terminalSessionId: "the source holds none and the target starts a new shell",
  terminalEnvTabName: "it names a running session's environment, which the exit cleared",
  keyboardProtocol: "a session negotiated it, and the target starts a new one",
  controlledTerminal: "it travels only with a live session, as the start command and environment it describes do not",
};

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

  test("the decision table names every field the type declares", () => {
    // The mapped type already refuses a missing line at compile time. This is
    // the other direction: the fixture below is `Required<TerminalTab>`, so a
    // name in the table that the type no longer declares shows up here rather
    // than as a decision nobody applies.
    expect([...fieldsDecided("carry"), ...fieldsDecided("drop")].sort()).toEqual(
      Object.keys(loadedTerminalTab()).sort(),
    );
  });

  test("every field the table marks carry arrives in the target window", async () => {
    const { moved } = await moveLoadedTerminal();
    const arrived = moved as unknown as Record<string, unknown>;

    for (const field of fieldsDecided("carry")) {
      expect(arrived[field], `${field} is marked carry`).toBeDefined();
    }
  });

  test("each carried field arrives with the value the source held", async () => {
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

  test("the Rich Prompt's style toolbar travels as its visibility does", async () => {
    const source = loadedTerminalTab();
    setRichPromptToolbarOpen(source.id, true);
    const payload = await dragPayload(source);
    const moved = reattachTerminalInPane(emptyTargetPane().id, {
      terminalSessionId: payload.terminalSessionId,
      title: payload.title,
      terminalEnvTabName: payload.terminalEnvTabName,
      group: payload.group,
      cwd: payload.cwd,
      ser: payload.ser as SerTab | undefined,
    });
    expect(moved, "the target rebuilds the terminal").not.toBeNull();
    expect(isRichPromptToolbarOpen(moved!.id)).toBe(true);
  });

  test("every field the table marks drop leaves the source's value behind", async () => {
    const { moved } = await moveLoadedTerminal();
    const source = loadedTerminalTab() as unknown as Record<string, unknown>;
    const arrived = moved as unknown as Record<string, unknown>;

    // Not "absent": four of the drops are rebuilt here with this window's own
    // value (a fresh id, this window's timestamp, and broadcast membership
    // reset). What no drop may do is arrive holding what the source held.
    for (const field of fieldsDecided("drop")) {
      expect(arrived[field], `${field} is marked drop`).not.toEqual(
        source[field],
      );
    }
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
    expect(moved.programStatus).toBeUndefined();
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

describe("a terminal with no session moved to another window", () => {
  /// Drag `source` and drop it in an empty pane of the receiving window.
  async function moveSessionless(source: TerminalTab = endedTerminalTab()) {
    showRichPromptForTab(source.id);
    const { dt, payload } = await startDrag(source);
    const { pane, accepted } = await dropInTarget(dt);
    expect(accepted, "the target claims the drop").toBe(true);
    expect(pane.tabs, "the target holds the moved tab").toHaveLength(1);
    return { payload, pane, moved: pane.tabs[0] as TerminalTab };
  }

  test("arrives with every carried field but those a session holds", async () => {
    const { moved } = await moveSessionless();
    const arrived = moved as unknown as Record<string, unknown>;

    for (const field of fieldsDecided("carry")) {
      const reason = NOT_ARRIVING_WITHOUT_A_SESSION[field];
      if (reason) expect(arrived[field], `${field}: ${reason}`).toBeFalsy();
      else expect(arrived[field], `${field} is marked carry`).toBeDefined();
    }
  });

  test("each carried field arrives with the value the source held", async () => {
    const { moved } = await moveSessionless();

    expect(moved.title).toBe("worker");
    expect(moved.group).toBe("ops");
    expect(moved.cwd).toBe("/work");
    expect(moved.profile).toBe("fish");
    expect(moved.inspectorOpen).toBe(true);
    expect(moved.inspectorWidth).toBe(310);
    expect(moved.richPromptDraftPath).toBe(".chan/drafts/worker/draft.md");
    expect(moved.richPromptCaret).toEqual({ from: 2, to: 5 });
    expect(moved.richPromptHeight).toBe(240);
    expect(moved.teamWorkPending).toEqual(defaultTeamConfig());
    expect(isRichPromptVisible(moved.id)).toBe(true);
  });

  test("the target says its session did not move", async () => {
    await moveSessionless();

    expect(ui.status).toBe("Moved terminal worker opened a new shell here; its session did not move");
    expect(ui.statusKind).toBe("persistent");
  });

  test("an unstarted tab's start command and environment stay behind, named and never valued", async () => {
    const source = endedTerminalTab();
    source.spawnCommand = "bash -l";
    source.spawnEnv = { CHAN_AGENT: "claude" };
    const { payload, moved } = await moveSessionless(source);

    expect(payload.left).toEqual(["session", "command", "environment"]);
    expect(JSON.stringify(payload)).not.toContain("bash -l");
    expect(JSON.stringify(payload)).not.toContain("CHAN_AGENT");
    expect(moved.spawnCommand).toBeUndefined();
    expect(moved.spawnEnv).toBeUndefined();
    expect(ui.status).toBe(
      "Moved terminal worker opened a new shell here; its session, start command and environment did not move",
    );
  });

  test("a payload from an older build arrives under its title, the session named", async () => {
    const { dt } = await startDrag(endedTerminalTab());
    dt.setData(CROSS_TAB_MIME, JSON.stringify({ kind: "terminal", title: "legacy" }));
    const { pane, accepted } = await dropInTarget(dt);

    expect(accepted).toBe(true);
    expect(pane.tabs).toHaveLength(1);
    expect((pane.tabs[0] as TerminalTab).title).toBe("legacy");
    expect(ui.status).toBe("Moved terminal legacy opened a new shell here; its session did not move");
  });

  test("a snapshot holding a session's own fields arrives without them", async () => {
    // This build writes the session id, the controlled flag and the keyboard
    // protocol only for a tab with a session, so the payload is edited as a
    // window on another build could send it, still with no session beside it.
    const kp = (await dragPayload(loadedTerminalTab())).ser.kp;
    expect(kp, "the live snapshot's keyboard protocol").toBeTruthy();
    const { dt, payload } = await startDrag(endedTerminalTab());
    dt.setData(CROSS_TAB_MIME, JSON.stringify({ ...payload, ser: { ...payload.ser, tsid: "sess-gone", tc: 1, kp } }));
    const { pane } = await dropInTarget(dt);
    const moved = pane.tabs[0] as TerminalTab;

    expect(moved.terminalSessionId).toBeUndefined();
    expect(moved.controlledTerminal).toBeFalsy();
    expect(moved.keyboardProtocol).toBeUndefined();
  });

  test("leaves the source without a question, marked as a move", async () => {
    const ended = await endDragAfterMove(endedTerminalTab());

    expect(ended.asked, "the source asks nothing").toBe(false);
    expect(ended.left, "the source's tab is gone").toBe(true);
    expect(ended.moving, "the close sink sees a move").toBe(true);
  });
});

describe("the source's drag-end after a live terminal moved", () => {
  test("lets the tab go without a question, marked as a move", async () => {
    // The live session keeps running in the other window, so the source's
    // close must neither ask nor kill.
    const ended = await endDragAfterMove(loadedTerminalTab());

    expect(ended.asked, "the source asks nothing").toBe(false);
    expect(ended.left, "the source's tab is gone").toBe(true);
    expect(ended.moving, "the close sink sees a move").toBe(true);
  });
});

/// End a drag of `source` from its pane as the browser does after another
/// window claimed the drop, with both of the tab's sinks registered as a
/// mounted terminal registers them; the close sink reads the move's mark as
/// TerminalTab's does. Whether the source asked, let the tab go, and saw a move.
async function endDragAfterMove(
  source: TerminalTab,
): Promise<{ asked: boolean; left: boolean; moving: boolean | null }> {
  let moving: boolean | null = null;
  cleanups.push(registerTerminalInputSink(source.id, () => {}));
  cleanups.push(
    registerTerminalCloseSink(source.id, () => {
      moving = isTerminalMoving(source.id);
      return true;
    }),
  );
  const { target } = await startDrag(source);
  const end = new Event("dragend", { bubbles: true }) as DragEvent;
  Object.defineProperty(end, "dataTransfer", { value: { dropEffect: "move" } });
  target.querySelector<HTMLElement>('[draggable="true"]')!.dispatchEvent(end);
  const sourceTabs = () => (layout.nodes[SOURCE_PANE] as LeafNode).tabs;
  await vi.waitFor(() => expect(confirmState.open || sourceTabs().length === 0).toBe(true));
  return { asked: confirmState.open, left: sourceTabs().length === 0, moving };
}
