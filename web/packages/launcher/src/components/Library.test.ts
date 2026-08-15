// Component test: the machine-first Library tree. The LOCAL block (home header +
// new-terminal + new-workspace) over its workspace cards; then one block per
// registered devserver -- connected or not -- whose globe header carries the
// name/address edit-config click target, new-terminal (connected only), and
// connect/disconnect, with its served workspaces nested as collapsible cards.
// Exercises the real Svelte 5 runtime (reactive re-render after connect /
// pending / status), per jsdom; readOnly is false here (the mutable surface).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Library from "./Library.svelte";
import ConfirmDialog from "./ConfirmDialog.svelte";
import { library, loadLibrary, saveDevserver, stopWatching } from "../state/library.svelte";
import { isSelected, toggleSelected, clearSelection, setSelectMode } from "../state/selection.svelte";
import { beginPending, clearAllPending, dsKey, isPending, wsKey } from "../state/pending.svelte";
import { confirm, requestConfirm, resolveConfirm, cancelConfirm } from "../state/confirm.svelte";
import { ApiError, type DevserverEntry, type WorkspaceEntry } from "../api/library";
import { controlAttention, clearAllControlAttention } from "../state/controlAttention.svelte";
import { collapsedState } from "../state/machineCollapse.svelte";
import { setDemoMode } from "../state/demo.svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountList(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Library, { target });
}

function ariaLabels(): string[] {
  return [...(target?.querySelectorAll("button[aria-label], input[aria-label]") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
}

function byAria(prefix: string): HTMLButtonElement | undefined {
  return [...(target?.querySelectorAll("button[aria-label]") ?? [])].find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(prefix),
  ) as HTMLButtonElement | undefined;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  const { resetMockRemoteWorkspaces } = await import("../api/mock");
  resetMockRemoteWorkspaces();
  clearSelection();
  clearAllPending();
  clearAllControlAttention();
  library.error = null;
  cancelConfirm();
  await loadLibrary();
});

afterEach(() => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  clearSelection();
  clearAllPending();
  clearAllControlAttention();
});

describe("Library: Local group", () => {
  it("renders local rows with icon actions, no per-row Remove, no pill", () => {
    mountList();
    expect(target!.textContent).not.toContain("Remove");
    expect(target!.querySelector(".pill")).toBeNull();
    const labels = ariaLabels();
    expect(labels.some((l) => l.startsWith("New window of"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Turn off") || l.startsWith("Turn on"))).toBe(true);
  });

  it("has a home header with new-terminal + new-workspace actions and no select-all", () => {
    mountList();
    expect(target!.querySelector(".machine-icon.live")).not.toBeNull();
    expect(target!.querySelector(".machine-header .status-dot")).toBeNull();
    expect(byAria("New local terminal")).toBeTruthy();
    expect(byAria("New local workspace")).toBeTruthy();
    // The select-all-local checkbox is gone (the mock has none); selection is
    // per-row, revealed by the top-bar Select toggle.
    expect(target!.querySelector('input[aria-label="Select all local workspaces"]')).toBeNull();
  });

  it("spins a local row from a pending marker, disabled, with the spinner svg", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    beginPending(wsKey(id), "off");
    flushSync();
    const spinning = target!.querySelector('button[aria-label^="Working on"]') as HTMLButtonElement;
    expect(spinning).toBeTruthy();
    expect(spinning.disabled).toBe(true);
    expect(spinning.querySelector("svg.spin")).toBeTruthy();
    expect(byAria("New window of notes")!.disabled).toBe(true);
  });

  it("spins a local row from backend transitional statuses alone (no marker)", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    for (const status of ["starting", "closing", "removing"] as const) {
      expect(isPending(wsKey(id))).toBe(false);
      library.workspaces = library.workspaces.map(
        (w): WorkspaceEntry => (w.workspace_id === id ? { ...w, status } : w),
      );
      flushSync();
      expect(target!.querySelector('button[aria-label^="Working on"]')).toBeTruthy();
    }
  });

  it("disables New window unless the workspace status is running", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    expect(byAria("New window of notes")!.disabled).toBe(false);
    for (const status of ["stopped", "starting", "locked", "closing", "removing", "error"] as const) {
      library.workspaces = library.workspaces.map(
        (w): WorkspaceEntry => (w.workspace_id === id ? { ...w, on: true, status } : w),
      );
      flushSync();
      expect(byAria("New window of notes")!.disabled).toBe(true);
    }
  });

  it("surfaces status:error with the reason and keeps the toggle enabled (retry)", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, status: "error", error: "open failed" } : w,
    );
    flushSync();
    expect(target!.querySelector('.row-error[title="open failed"]')).toBeTruthy();
    const toggle = target!.querySelector(
      'button[aria-label^="Turn off"], button[aria-label^="Turn on"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.disabled).toBe(false);
  });

  it("renders status:locked with a disabled lock control", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, on: false, status: "locked" } : w,
    );
    flushSync();
    const toggle = byAria("notes is open in another Chan process")!;
    expect(toggle).toBeTruthy();
    expect(toggle.disabled).toBe(true);
    expect(toggle.classList.contains("locked")).toBe(true);
    expect(toggle.querySelector("svg")).toBeTruthy();
    expect(toggle.title).toBe("Workspace is open in another Chan process");
    expect(byAria("New window of notes")!.disabled).toBe(true);
  });

  it("checks the row when a local workspace is selected", () => {
    mountList();
    const localId = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    toggleSelected("workspace", localId);
    flushSync();
    const checks = [...target!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checks.some((c) => c.checked)).toBe(true);
  });
});

describe("Library: devserver groups", () => {
  it("renders a connected devserver as its own group: Disconnect + enabled New terminal + Edit config + endpoint", () => {
    mountList();
    // Seed devserver "prod" (ds-1) is connected.
    expect(byAria("Disconnect prod")).toBeTruthy();
    const newTerm = byAria("New terminal on prod");
    expect(newTerm).toBeTruthy();
    expect(newTerm!.disabled).toBe(false);
    // The header name/address block is the edit-config click target.
    expect(byAria("Edit config for prod")).toBeTruthy();
    // The header carries the endpoint as host:port.
    expect(target!.textContent).toContain("box.example.com:8787");
    // The devserver is bulk-selectable once the checkboxes are revealed.
    setSelectMode(true);
    flushSync();
    expect(target!.querySelector('input[aria-label="Select prod"]')).not.toBeNull();
  });

  it("offers no files-window action: a files window is opened from a terminal", () => {
    // The launcher spawns terminals and workspace windows; a Files window is
    // opened with `cs window new --app files` from a terminal, so no machine
    // card advertises one.
    mountList();
    expect(byAria("New terminal on prod")).toBeTruthy();
    expect(ariaLabels().some((l) => l.toLowerCase().includes("files window"))).toBe(false);
  });

  it("nests the connected devserver's served workspaces as rows with a checkbox and no Forget", () => {
    mountList();
    expect(target!.textContent).toContain("/srv/api");
    expect(ariaLabels().some((l) => l.startsWith("Forget"))).toBe(false);
    // The served row carries the workspace on/off + new-window actions.
    expect(byAria("New window of api")).toBeTruthy();
    expect(byAria("Turn off api")).toBeTruthy();
    // ...and reveals a select checkbox in select mode.
    setSelectMode(true);
    flushSync();
    expect(target!.querySelector('input[aria-label="Select api"]')).not.toBeNull();
  });

  it("still shows a DISCONNECTED devserver as a header with Connect, a prompt, and no New terminal", async () => {
    await saveDevserver({ host: "fresh.example", port: 9100, label: "fresh" });
    mountList();
    const connect = byAria("Connect fresh");
    expect(connect).toBeTruthy();
    expect(connect!.disabled).toBe(false);
    // New terminal is hidden until connected (it appears on connect).
    expect(byAria("New terminal on fresh")).toBeUndefined();
    expect(byAria("Edit config for fresh")).toBeTruthy();
    // A disconnected devserver shows the connect prompt, no content.
    expect(target!.textContent).toContain("Not connected");
  });

  it("narrates a pending browser sign-in as a waiting row with a live re-click Connect", async () => {
    // A gateway connect that handed off to the browser: status stays
    // disconnected (waiting is a row state, not a connection state), but the
    // row must narrate the wait instead of sitting at "Not connected", keep
    // the red icon reserved for dropped live connections, and keep the plug
    // clickable so a re-click re-opens the sign-in page.
    await saveDevserver({ host: "gw.example", port: 443, label: "gw" });
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.host === "gw.example" ? { ...d, pending_signin: true } : d),
    );

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const gw = machines.find((m) => m.textContent?.includes("gw.example"));
    expect(gw).toBeTruthy();
    expect(gw!.textContent).toContain("Waiting for sign-in in your browser...");
    expect(gw!.textContent).not.toContain("Not connected");
    const waiting = gw!.querySelector(".connect-prompt.waiting");
    expect(waiting).not.toBeNull();
    expect(waiting!.querySelector("svg.spin")).not.toBeNull();
    // No red icon: the wait is not a dropped connection.
    expect(gw!.querySelector(".ds-glyph.lost")).toBeNull();
    // The plug stays live and says what a re-click does.
    const reopen = byAria("Re-open sign-in in your browser for gw");
    expect(reopen).toBeTruthy();
    expect(reopen!.disabled).toBe(false);
  });

  it("turns the machine icon red for a connected devserver that needs attention", () => {
    const ds = library.devservers.find((d) => d.id === "ds-1")!;
    controlAttention.libs[ds.library_id!] = true;

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    expect(prod!.textContent).toContain("Control terminal");
    // The textual connection-lost cue is the identity row's OS icon turned
    // red (the same icon that shows green while connected), not a flashing
    // pill; the control row's eye still flashes for attention.
    expect(prod!.querySelector(".ds-glyph.lost")).not.toBeNull();
    expect(prod!.querySelector(".ds-glyph.live")).toBeNull();
    expect(prod!.querySelector(".status-dot")).toBeNull();
    expect(prod!.querySelector("button.icon-btn.attention")).not.toBeNull();
    const disconnect = byAria("Disconnect prod");
    expect(disconnect).toBeTruthy();
    expect(disconnect!.classList.contains("lost")).toBe(true);
    expect(disconnect!.classList.contains("on")).toBe(false);
  });

  it("renders a disconnected devserver's DEAD control row with a red icon so it can be reopened", () => {
    // A control script died: the devserver is marked disconnected but its control
    // terminal stays ALIVE in the feed sitting at "process exited". The launcher
    // must keep that row mounted, with the identity icon red, so the user can open
    // it to read the death reason; the row only clears once the control terminal
    // is closed and leaves the feed (covered by the reaped-control test below).
    const ds = library.devservers.find((d) => d.id === "ds-1")!;
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "disconnected" } : d),
    );
    controlAttention.libs[ds.library_id!] = true;

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    expect(prod!.textContent).toContain("Control terminal");
    expect(prod!.textContent).not.toContain("Not connected");
    expect(prod!.querySelector(".ds-glyph.lost")).not.toBeNull();
    expect(prod!.querySelector("button.icon-btn.attention")).not.toBeNull();
  });

  it("turns the identity icon red for an unreachable devserver off the status field alone", () => {
    // The desktop watchdog marks a post-sleep zombie `unreachable` while the
    // connection record still exists. The launcher shows the red "lost" icon from
    // the status field with NO control attention (a gateway devserver can't hold
    // it), and keeps the content visible so each window can raise its own
    // Reconnect overlay.
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "unreachable" } : d),
    );

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    // Red lost icon, no green live icon -- driven purely by status (no attention set).
    expect(prod!.querySelector(".ds-glyph.lost")).not.toBeNull();
    expect(prod!.querySelector(".ds-glyph.live")).toBeNull();
    // Content stays mounted (not collapsed to the "Not connected" prompt).
    expect(prod!.textContent).toContain("Control terminal");
    expect(prod!.textContent).not.toContain("Not connected");
    // The connection record still exists, so it keeps the (red "lost") Disconnect
    // affordance -- not the plug Connect, which would stack a second connect.
    const disconnect = byAria("Disconnect prod");
    expect(disconnect).toBeTruthy();
    expect(disconnect!.classList.contains("lost")).toBe(true);
    expect(disconnect!.classList.contains("on")).toBe(false);
    expect(disconnect!.title).toBe("Disconnect lost connection");
    expect(byAria("Connect prod")).toBeUndefined();
  });

  it("renders a connecting devserver's control row while it is dialing", () => {
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "connecting" } : d),
    );

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    expect(prod!.textContent).toContain("Control terminal");
    expect(prod!.textContent).not.toContain("Not connected");
    expect(byAria("Working on prod")).toBeTruthy();
    expect(prod!.querySelector(".ds-glyph.working")).not.toBeNull();
    expect(prod!.querySelector(".ds-glyph.live")).toBeNull();
  });

  it("does not retain a reaped control row from stale attention alone", () => {
    const ds = library.devservers.find((d) => d.id === "ds-1")!;
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "disconnected" } : d),
    );
    library.windows = library.windows.filter((w) => !(w.control && w.library_id === ds.library_id));
    controlAttention.libs[ds.library_id!] = true;

    mountList();

    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    expect(prod!.textContent).not.toContain("Control terminal");
    expect(prod!.textContent).toContain("Not connected");
  });

  it("fires connect and flips the disconnected devserver to Disconnect", async () => {
    await saveDevserver({ host: "fresh2.example", port: 9101, label: "fresh2" });
    mountList();
    byAria("Connect fresh2")!.click();
    await settle();
    flushSync();
    expect(library.error).toBeNull();
    const fresh = library.devservers.find((d) => d.host === "fresh2.example")!;
    expect(fresh.status).toBe("connected");
    expect(byAria("Disconnect fresh2")).toBeTruthy();
  });

  it("swaps Connect/Disconnect for a disabled spinner while a devserver op is pending", () => {
    mountList();
    expect(byAria("Disconnect prod")).toBeTruthy();
    beginPending(dsKey("ds-1"), "disconnected");
    flushSync();
    const spinning = byAria("Working on prod");
    expect(spinning).toBeTruthy();
    expect(spinning!.disabled).toBe(true);
    expect(spinning!.querySelector("svg.spin")).toBeTruthy();
    expect(
      [...target!.querySelectorAll("section.machine")]
        .find((machine) => machine.textContent?.includes("box.example.com:8787"))
        ?.querySelector(".ds-glyph.working"),
    ).not.toBeNull();
    expect(byAria("Disconnect prod")).toBeUndefined();
  });

  it("spins a devserver from status:connecting alone, then clears on disconnect", () => {
    mountList();
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "connecting" } : d),
    );
    flushSync();
    expect(byAria("Working on prod")).toBeTruthy();
    const libId = library.devservers.find((d) => d.id === "ds-1")!.library_id;
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "disconnected" } : d),
    );
    // A plain disconnect reaps the control terminal, so its control row leaves
    // the feed; only a dead-control-terminal disconnect keeps it (which gates
    // Connect, covered below). Drop it so this asserts the plain reconnect path.
    library.windows = library.windows.filter((w) => !(w.control && w.library_id === libId));
    flushSync();
    expect(byAria("Working on prod")).toBeUndefined();
    expect(byAria("Connect prod")).toBeTruthy();
  });

  it("gates Connect while a disconnected devserver still owns a dead control terminal", () => {
    mountList();
    const libId = library.devservers.find((d) => d.id === "ds-1")!.library_id!;
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "disconnected" } : d),
    );
    // Explicitly seed the dead control terminal so this is independent of the
    // mock feed's re-seed timing: a disconnected devserver that still owns a
    // control record (script died, terminal kept open at "process exited").
    library.windows = [
      ...library.windows.filter((w) => !(w.control && w.library_id === libId)),
      {
        window_id: `control-terminal-${libId}`,
        library_id: libId,
        kind: "terminal",
        title: "Control terminal",
        ordinal: 0,
        workspace_path: null,
        prefix: "",
        token: "",
        persisted: true,
        connected: true,
        control: true,
      },
    ];
    flushSync();
    // The plain "Connect" is gated: the user must close the control terminal (or
    // use the overlay Reconnect) first, else the connect op errors.
    expect(byAria("Connect prod")).toBeUndefined();
    const gated = byAria("Close the control terminal to reconnect prod");
    expect(gated).toBeTruthy();
    expect(gated!.disabled).toBe(true);
  });

  it("checks the devserver row when selected", () => {
    mountList();
    toggleSelected("devserver", "ds-1");
    flushSync();
    const check = target!.querySelector('input[aria-label="Select prod"]') as HTMLInputElement;
    expect(check.checked).toBe(true);
  });
});

describe("Library: workspace OFF confirm-and-retry", () => {
  function apiOn(prefix: string): boolean {
    return library.workspaces.find((w) => w.devserver_id === "ds-1" && w.prefix === prefix)!.on;
  }
  function offButton(label: string): HTMLButtonElement {
    const btn = [...(target?.querySelectorAll("button[aria-label]") ?? [])].find(
      (b) => b.getAttribute("aria-label") === label,
    );
    if (!btn) throw new Error(`no button labelled "${label}"`);
    return btn as HTMLButtonElement;
  }

  it("opens the confirm with N and turns off only on confirm (remote workspace)", async () => {
    mountList();
    expect(apiOn("w/api")).toBe(true);
    expect(confirm.open).toBe(false);
    offButton("Turn off api").click();
    await settle();
    flushSync();
    expect(confirm.open).toBe(true);
    expect(confirm.message).toContain("2 live terminal sessions");
    expect(apiOn("w/api")).toBe(true);
    await resolveConfirm();
    flushSync();
    expect(confirm.open).toBe(false);
    expect(apiOn("w/api")).toBe(false);
    expect(library.error).toBeNull();
  });

  it("does NOT open the confirm for a non-live_terminals (NO_DESKTOP) 409", async () => {
    const { backend } = await import("../api/backend");
    const spy = vi
      .spyOn(backend, "setDevserverWorkspaceOn")
      .mockRejectedValueOnce(new ApiError(409, "NO_DESKTOP"));
    mountList();
    offButton("Turn off api").click();
    await settle();
    flushSync();
    expect(confirm.open).toBe(false);
    expect(library.error).toBe("NO_DESKTOP");
    spy.mockRestore();
  });

  it("opens the SAME confirm-and-retry for a LOCAL workspace off", async () => {
    const { setMockLocalLiveTerminals } = await import("../api/mock");
    const ws = library.workspaces.find((w) => w.devserver_id === null && w.on)!;
    setMockLocalLiveTerminals(ws.workspace_id, 3);
    mountList();
    offButton("Turn off notes").click();
    await settle();
    flushSync();
    expect(confirm.open).toBe(true);
    expect(confirm.message).toContain("3 live terminal sessions");
    expect(library.workspaces.find((w) => w.workspace_id === ws.workspace_id)!.on).toBe(true);
    await resolveConfirm();
    flushSync();
    expect(confirm.open).toBe(false);
    expect(library.workspaces.find((w) => w.workspace_id === ws.workspace_id)!.on).toBe(false);
    expect(library.error).toBeNull();
  });

  it("renders the confirm via the in-SPA Modal (role=dialog), never a native one", () => {
    // ConfirmDialog is built on Modal -- a role="dialog" overlay -- so the prompt
    // is in-SPA, not window.confirm (no_native_dialogs.test.ts enforces no native
    // dialog calls anywhere in shipped sources).
    requestConfirm({
      title: "Turn off workspace?",
      message: "2 sessions still running.",
      onConfirm: () => {},
    });
    flushSync();
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(ConfirmDialog, { target });
    flushSync();
    const dlg = target.querySelector('[role="dialog"]');
    expect(dlg).not.toBeNull();
    expect(dlg?.getAttribute("aria-label")).toBe("Turn off workspace?");
    expect(target.textContent).toContain("still running");
    cancelConfirm();
  });
});

describe("Library: nested machine tree", () => {
  it("renders the LOCAL machine block with Terminals + Workspaces sections", () => {
    mountList();
    expect(target!.textContent).toContain("This machine");
    expect(target!.textContent).toContain("Terminals");
    expect(target!.textContent).toContain("Workspaces");
    // The local standalone terminal renders as a window row with a focus action.
    expect(target!.querySelector('[aria-label="Focus window"]')).not.toBeNull();
  });

  it("pins the control terminal first in a connected devserver's terminals", () => {
    mountList();
    // ds-1 ("prod") is connected and owns a control terminal; it sorts first.
    const machines = [...target!.querySelectorAll("section.machine")];
    const prod = machines.find((m) => m.textContent?.includes("box.example.com:8787"));
    expect(prod).toBeTruthy();
    const firstRowName = prod!.querySelector(".term-list .row-name");
    expect(firstRowName?.textContent?.trim()).toBe("Control terminal");
  });

  it("shows a clickable window-count badge and expands a card to reveal its nested windows", () => {
    mountList();
    // The connected ds-1's "api" workspace owns one window (its window survives
    // the shared mock across tests, unlike a local one that an off discards);
    // collapsed by default with a count badge and no nested-windows panel. The
    // workspace-card badge lives inside .ws-head (the machine-card collapse
    // toggle also uses .count-badge, hence the scoped selector).
    const badge = target!.querySelector(".ws-head .count-badge") as HTMLButtonElement;
    expect(badge?.textContent).toContain("1");
    expect(badge?.getAttribute("aria-expanded")).toBe("false");
    expect(target!.querySelector(".ws-windows")).toBeNull();
    badge.click();
    flushSync();
    // Expanded: the nested-windows panel appears with the window row, labelled
    // just "Window N" (the card already names the workspace, no path repeated).
    const panel = target!.querySelector(".ws-windows");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("Window 1");
    expect(target!.querySelector(".ws-head .count-badge")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    (target!.querySelector(".ws-head .count-badge") as HTMLButtonElement).click();
    flushSync();
    expect(target!.querySelector(".ws-windows")).toBeNull();
  });
});

describe("Library: machine collapse", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    collapsedState.keys = [];
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    collapsedState.keys = [];
    vi.unstubAllGlobals();
  });

  function machineSection(match: string): HTMLElement {
    const s = [...(target?.querySelectorAll("section.machine") ?? [])].find((m) =>
      m.textContent?.includes(match),
    );
    if (!s) throw new Error(`no machine section containing "${match}"`);
    return s as HTMLElement;
  }

  it("renders the collapse toggle FIRST in the machine actions, before the Terminal button", () => {
    mountList();
    const actions = machineSection("This machine").querySelector(".machine-actions")!;
    const buttons = [...actions.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons[0]!.classList.contains("count-badge")).toBe(true);
    expect(buttons[0]!.classList.contains("machine-toggle")).toBe(true);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Collapse windows of This machine");
    // The pre-existing machine actions follow the toggle.
    expect(buttons[1]!.getAttribute("aria-label")).toBe("New local terminal");
  });

  it("counts every window the machine owns, matching the pure tree count", async () => {
    // The shared mock `windows` array is mutated across tests (an off discards
    // local workspace windows), so assert the badge equals the live tree count
    // rather than a hardcoded number.
    const { buildMachineTree, machineWindowCount } = await import("../lib/machineTree");
    mountList();
    const tree = buildMachineTree(library.devservers, library.workspaces, library.windows);
    const localCount = machineWindowCount(tree.machines.find((m) => m.kind === "local")!);
    const prodCount = machineWindowCount(tree.machines.find((m) => m.devserver?.id === "ds-1")!);
    expect(localCount).toBeGreaterThan(0);
    expect(prodCount).toBeGreaterThan(0);
    const digits = (el: Element | null): string => (el?.textContent ?? "").replace(/\D/g, "");
    expect(
      digits(machineSection("This machine").querySelector(".machine-actions .count-badge")),
    ).toBe(String(localCount));
    expect(
      digits(machineSection("box.example.com:8787").querySelector(".machine-actions .count-badge")),
    ).toBe(String(prodCount));
  });

  it("collapses the machine to its header row and expands it back, flipping aria-expanded", () => {
    mountList();
    const local = machineSection("This machine");
    const toggle = local.querySelector(".machine-actions .count-badge") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(local.querySelector(".machine-content")).not.toBeNull();
    expect(local.textContent).toContain("Terminals");

    toggle.click();
    flushSync();
    const collapsed = machineSection("This machine").querySelector(
      ".machine-actions .count-badge",
    ) as HTMLButtonElement;
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.getAttribute("aria-label")).toBe("Expand windows of This machine");
    // Content gone; the header (name + toggle) stays mounted.
    expect(machineSection("This machine").querySelector(".machine-content")).toBeNull();
    expect(machineSection("This machine").textContent).toContain("This machine");
    // The collapse mirrored to the desktop config (best-effort PUT).
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/library/collapsed-machines",
      expect.objectContaining({ method: "PUT" }),
    );

    collapsed.click();
    flushSync();
    expect(machineSection("This machine").querySelector(".machine-content")).not.toBeNull();
  });

  it("collapses a disconnected devserver's connect prompt to its header alone", async () => {
    await saveDevserver({ host: "fresh.example", port: 9100, label: "fresh" });
    mountList();
    const fresh = machineSection("fresh.example");
    expect(fresh.textContent).toContain("Not connected");
    const toggle = fresh.querySelector(".machine-actions .count-badge") as HTMLButtonElement;
    // No windows on a never-connected devserver.
    expect(toggle.textContent).toContain("0");

    toggle.click();
    flushSync();
    const collapsed = machineSection("fresh.example");
    expect(collapsed.textContent).not.toContain("Not connected");
    // The identity header (name/address) still renders.
    expect(collapsed.textContent).toContain("fresh.example");
  });
});

describe("Library: demo mode", () => {
  afterEach(() => {
    setDemoMode(null);
  });

  it("repurposes FolderPlus into Reset only when a reset callback is registered", () => {
    setDemoMode({ reset: () => {} });
    mountList();
    expect(byAria("Reset demo data")).toBeTruthy();
    expect(byAria("New local workspace")).toBeUndefined();
  });

  it("keeps the real New-workspace action in demo mode without a reset", () => {
    setDemoMode({});
    mountList();
    expect(byAria("New local workspace")).toBeTruthy();
    expect(byAria("Reset demo data")).toBeUndefined();
  });
});

// Selection across all three kinds is covered above (local + devserver) and in
// selection.svelte.test.ts; the served-kind check is exercised by the remote
// confirm test selecting/acting on api rows.
void isSelected;
