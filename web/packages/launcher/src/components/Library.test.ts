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
import {
  ApiError,
  type DevserverEntry,
  type TmuxConnectionEntry,
  type WindowRecord,
  type WorkspaceEntry,
} from "../api/library";
import { controlAttention, clearAllControlAttention } from "../state/controlAttention.svelte";
import { setDemoMode } from "../state/demo.svelte";
import { windowRowLabel } from "../lib/windowLabel";

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
  it("names chan open in the local empty hint", () => {
    library.workspaces = [];
    library.windows = [];
    mountList();

    const local = [...target!.querySelectorAll("section.machine")].find((machine) =>
      machine.textContent?.includes("This machine"),
    );
    expect(local?.querySelector(".empty-hint")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "No workspaces yet. Add one with the buttons above, or run chan open /path/to/project in a terminal.",
    );
  });

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

  it("names an observed state that contradicts the desired one on the power control", () => {
    // The editable row has no state word: the power control shows the desired
    // state (lit when on) and New window shows the observed one (enabled only
    // while running). When a settled observed state contradicts the desired
    // one, the control says both rather than leaving the two to disagree.
    mountList();
    const cases: Array<[boolean, WorkspaceEntry["status"], string]> = [
      [false, "running", "Turn on (Off, running)"],
      [true, "stopped", "Turn off (On, stopped)"],
      [true, "error", "Turn off (On, failed)"],
      [true, "running", "Turn off"],
      [false, "stopped", "Turn on"],
    ];
    const seen = cases.map(([on, status]) => {
      library.workspaces = library.workspaces.map(
        (w): WorkspaceEntry => (w.workspace_id === "ws-1" ? { ...w, on, status } : w),
      );
      flushSync();
      const power = [...target!.querySelectorAll<HTMLButtonElement>("button[aria-label]")].find(
        (b) => /^Turn (on|off) notes/.test(b.getAttribute("aria-label") ?? ""),
      );
      return [on, status, power?.title ?? "", power?.getAttribute("aria-label") ?? ""];
    });
    expect(seen).toEqual(
      cases.map(([on, status, title]) => [
        on,
        status,
        title,
        title.replace(/^Turn (on|off)/, (verb) => `${verb} notes`),
      ]),
    );
  });

  it("disables New window unless the workspace status is running", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    expect(byAria("New window of notes")!.disabled).toBe(false);
    for (const status of [
      "stopped",
      "starting",
      "locked",
      "closing",
      "removing",
      "error",
      "unavailable",
      "unknown",
    ] as const) {
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

  it("renders status:unknown as a disabled control that names no other process", () => {
    // The lock probe failed: the row offers nothing, shows the probe's reason,
    // and must not claim another Chan process holds the workspace.
    const reason = "lock file could not be opened: Too many open files";
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, on: false, status: "unknown", error: reason } : w,
    );
    flushSync();
    const toggle = byAria("Lock state of notes could not be read")!;
    expect(toggle).toBeTruthy();
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Could not read this workspace's lock state");
    expect(toggle.title).not.toContain("another Chan process");
    expect(byAria("notes is open in another Chan process")).toBeFalsy();
    expect((target!.querySelector(".row-error") as HTMLElement).title).toBe(reason);
    expect(byAria("New window of notes")!.disabled).toBe(true);
  });

  it("shows a degraded row's reason, offers Turn off, and keeps New window disabled", () => {
    // status:unavailable is a mount that is up over a root it cannot read. The
    // row carries `on: true` and the reason the server built; the only action
    // that helps is turning it off.
    const reason =
      "workspace root does not exist: /home/me/notes; turn this workspace off and on, " +
      "or run chan close, to mount that path again";
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, on: true, status: "unavailable", error: reason } : w,
    );
    flushSync();

    // The reason is displayed exactly as it arrived: the launcher never matches
    // on it, since it differs between a stalled mount and a replaced root.
    const mark = target!.querySelector(".row-error") as HTMLElement;
    expect(mark.title).toBe(reason);
    expect(mark.classList.contains("degraded")).toBe(true);

    const toggle = byAria("Turn off notes")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.title).toBe("Turn off");
    // Degraded, not healthy: the accent tint the running row carries is gone.
    expect(toggle.classList.contains("degraded")).toBe(true);
    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.classList.contains("locked")).toBe(false);
    expect(toggle.querySelector("svg.spin")).toBeNull();
    expect(byAria("New window of notes")!.disabled).toBe(true);
  });

  it("leaves running and error rows drawn the way they were", () => {
    mountList();
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    // A running row: no reason mark, the accent-tinted toggle, New window open.
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, on: true, status: "running", error: undefined } : w,
    );
    flushSync();
    expect(target!.querySelector(".row-error")).toBeNull();
    const running = byAria("Turn off notes")!;
    expect(running.classList.contains("on")).toBe(true);
    expect(running.classList.contains("degraded")).toBe(false);
    expect(byAria("New window of notes")!.disabled).toBe(false);

    // An error row: the danger mark, not the degraded one.
    library.workspaces = library.workspaces.map(
      (w): WorkspaceEntry =>
        w.workspace_id === id ? { ...w, on: true, status: "error", error: "open failed" } : w,
    );
    flushSync();
    const mark = target!.querySelector('.row-error[title="open failed"]') as HTMLElement;
    expect(mark).toBeTruthy();
    expect(mark.classList.contains("degraded")).toBe(false);
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

  it("offers no files-window action: a terminal window IS the file window", () => {
    // There is one standalone window family. A standalone terminal window
    // browses and edits the machine's filesystem itself, wherever the host
    // serves one, so the launcher has no separate Files action to offer.
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
    expect(disconnect!.title).toBe("Disconnect lost connection (c)");
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
        active_transfer: false,
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
    const titleId = dlg?.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe("Turn off workspace?");
    expect(target.textContent).toContain("still running");
    cancelConfirm();
  });
});

describe("Library: turning on a workspace whose root is not usable", () => {
  // `POST .../on` answers 200 with the row over such a mount: the verb
  // succeeded, so nothing here is an error. The re-list behind it replaces the
  // stale off row with the degraded one, and the banner stays closed.
  it("lists the row as degraded and opens no error bubble", async () => {
    const { backend } = await import("../api/backend");
    // The mutable-surface suites share one mock registry, so which local row is
    // off depends on what ran before: name the row from the one found here.
    const off = library.workspaces.find((w) => w.devserver_id === null && !w.on)!;
    const name = off.label || off.path.split("/").filter(Boolean).at(-1)!;
    const reason =
      `workspace root does not exist: ${off.path}; turn this workspace off and on, ` +
      "or run chan close, to mount that path again";
    const onSpy = vi.spyOn(backend, "setWorkspaceOn").mockResolvedValueOnce(undefined);
    const listSpy = vi.spyOn(backend, "listWorkspaces").mockImplementation(async () =>
      library.workspaces.map((w) =>
        w.workspace_id === off.workspace_id
          ? { ...w, on: true, status: "unavailable" as const, error: reason }
          : w,
      ),
    );
    try {
      mountList();
      const calls = listSpy.mock.calls.length;

      byAria(`Turn on ${name}`)!.click();
      await settle();
      flushSync();

      expect(library.error).toBeNull();
      expect(listSpy.mock.calls.length).toBeGreaterThan(calls);
      const row = library.workspaces.find((w) => w.workspace_id === off.workspace_id)!;
      expect(row.status).toBe("unavailable");
      expect(row.error).toBe(reason);
      // The row draws the degraded state instead of the stale off one, offers
      // the one action that helps it, and still cannot mint a window.
      expect(target!.querySelector(`.row-error.degraded[title="${reason}"]`)).toBeTruthy();
      expect(byAria(`Turn off ${name}`)).toBeTruthy();
      expect(byAria(`New window of ${name}`)!.disabled).toBe(true);
    } finally {
      // The list stub answers for the whole registry, so a failure here would
      // follow the shared mock state into the next case.
      onSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  // The enveloped 409 for a mount another chan process holds carries its own
  // sentence, and it reaches the banner unchanged.
  it("shows an enveloped lock refusal in the banner", async () => {
    const { backend } = await import("../api/backend");
    const off = library.workspaces.find((w) => w.devserver_id === null && !w.on)!;
    const name = off.label || off.path.split("/").filter(Boolean).at(-1)!;
    const locked = "This workspace is open in another chan process. Quit it and try again.";
    const onSpy = vi
      .spyOn(backend, "setWorkspaceOn")
      .mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: locked })));
    try {
      mountList();

      byAria(`Turn on ${name}`)!.click();
      await settle();
      flushSync();

      expect(library.error).toBe(locked);
    } finally {
      onSpy.mockRestore();
    }
  });
});

describe("Library: nested machine tree", () => {
  it("keeps namesake workspace cards independently expanded across feed updates", () => {
    const remote = library.workspaces.find((ws) => ws.devserver_id !== null)!;
    const local = library.workspaces.find((ws) => ws.devserver_id === null)!;
    const window = library.windows.find((w) => w.workspace_path === remote.path)!;
    library.workspaces = [local, { ...remote, workspace_id: local.workspace_id, prefix: local.prefix }];
    library.windows = [
      { ...window, window_id: "local-card-window", library_id: local.library_id!, workspace_path: local.path },
      window,
    ];
    mountList();
    const cards = [...target!.querySelectorAll(".ws-card")];
    expect(cards).toHaveLength(2);
    const chevron = (card: Element) => card.querySelector<HTMLButtonElement>(".chevron")!;
    chevron(cards[0]).click();
    flushSync();
    expect(chevron(cards[0]).getAttribute("aria-expanded")).toBe("true");
    expect(chevron(cards[1]).getAttribute("aria-expanded"), "the other machine stays collapsed").toBe("false");
    expect(cards[1].querySelector(".ws-windows")).toBeNull();
    chevron(cards[1]).click();
    flushSync();
    chevron(cards[0]).click();
    flushSync();
    library.workspaces = library.workspaces.map((ws) => ({ ...ws }));
    flushSync();
    expect(chevron(cards[0]).getAttribute("aria-expanded")).toBe("false");
    expect(cards[0].querySelector(".ws-windows")).toBeNull();
    expect(chevron(cards[1]).getAttribute("aria-expanded")).toBe("true");
    expect(cards[1].querySelector(".ws-windows")).not.toBeNull();
  });

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

  it("shows a workspace's window count as text and expands its nested windows with the chevron", () => {
    mountList();
    // The connected ds-1's "api" workspace owns one window (its window survives
    // the shared mock across tests, unlike a local one that an off discards);
    // collapsed by default, with no nested-windows panel.
    const badge = target!.querySelector<HTMLElement>(".ws-head .count-badge")!;
    const head = badge.closest<HTMLElement>(".ws-head")!;
    expect(badge.textContent).toContain("1");
    expect(target!.querySelector(".ws-windows")).toBeNull();
    const chevron = head.querySelector<HTMLButtonElement>(".chevron")!;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    chevron.click();
    flushSync();
    // Expanded: the nested-windows panel appears with the window row, labelled
    // just "Window N" (the card already names the workspace, no path repeated).
    const panel = target!.querySelector(".ws-windows");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("Window 1");
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    chevron.click();
    flushSync();
    expect(target!.querySelector(".ws-windows")).toBeNull();
  });
});

describe("Library: window counts", () => {
  function machineSection(match: string): HTMLElement {
    const s = [...(target?.querySelectorAll("section.machine") ?? [])].find((m) =>
      m.textContent?.includes(match),
    );
    if (!s) throw new Error(`no machine section containing "${match}"`);
    return s as HTMLElement;
  }

  const digits = (el: Element | null): string => (el?.textContent ?? "").replace(/\D/g, "");
  const title = (n: number): string => `${n} window${n === 1 ? "" : "s"}`;

  it("renders machine and workspace counts as plain text, never as buttons", async () => {
    // The shared mock `windows` array is mutated across tests (an off discards
    // local workspace windows), so the expected numbers come from the live tree.
    const { buildMachineTree, machineWindowCount } = await import("../lib/machineTree");
    mountList();
    const tree = buildMachineTree(library.devservers, library.workspaces, library.windows);
    const localCount = machineWindowCount(tree.machines.find((m) => m.kind === "local")!);
    const prodCount = machineWindowCount(tree.machines.find((m) => m.devserver?.id === "ds-1")!);
    expect(localCount).toBeGreaterThan(0);
    expect(prodCount).toBeGreaterThan(0);

    const machines: [string, number][] = [
      ["This machine", localCount],
      ["box.example.com:8787", prodCount],
    ];
    for (const [name, count] of machines) {
      const badges = machineSection(name).querySelectorAll<HTMLElement>(".machine-actions .count-badge");
      expect(badges, name).toHaveLength(1);
      const badge = badges[0]!;
      expect(badge.tagName, name).toBe("SPAN");
      expect(badge.closest("button"), name).toBeNull();
      expect(badge.hasAttribute("tabindex"), name).toBe(false);
      expect(badge.getAttribute("title"), name).toBe(title(count));
      expect(digits(badge), name).toBe(String(count));
    }

    const wsBadge = target!.querySelector<HTMLElement>(".ws-head .count-badge")!;
    expect(wsBadge.tagName).toBe("SPAN");
    expect(wsBadge.closest("button")).toBeNull();
    expect(wsBadge.getAttribute("title")).toBe(title(Number(digits(wsBadge))));
    expect(Number(digits(wsBadge))).toBeGreaterThan(0);

    expect(target!.querySelector("button.count-badge")).toBeNull();
    expect(ariaLabels().filter((l) => / windows( of |$)/.test(l))).toEqual([]);
  });

  it("leads the local machine actions with the New terminal button", () => {
    mountList();
    const actions = machineSection("This machine").querySelector(".machine-actions")!;
    const buttons = [...actions.querySelectorAll("button")];
    expect(buttons[0]!.getAttribute("aria-label")).toBe("New local terminal");
  });

  it("shows a disconnected devserver's zero count beside its connect prompt", async () => {
    await saveDevserver({ host: "fresh.example", port: 9100, label: "fresh" });
    mountList();
    const fresh = machineSection("fresh.example");
    const badge = fresh.querySelector<HTMLElement>(".machine-actions .count-badge")!;
    expect(badge.tagName).toBe("SPAN");
    expect(digits(badge)).toBe("0");
    expect(badge.getAttribute("title")).toBe("0 windows");
    expect(fresh.textContent).toContain("Not connected");
  });

  it("shows the machine's windows even when an old collapsed set is still stored", () => {
    // A collapsed set may still sit under this key in localStorage; the
    // launcher ignores it, so every machine card renders its content.
    localStorage.setItem("chan-launcher-collapsed-machines", JSON.stringify(["local", "ds-1"]));
    try {
      mountList();
      expect(machineSection("This machine").querySelector(".machine-content")).not.toBeNull();
      expect(machineSection("box.example.com:8787").querySelector(".machine-content")).not.toBeNull();
    } finally {
      localStorage.removeItem("chan-launcher-collapsed-machines");
    }
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

describe("Library: tmux connection cards", () => {
  const LOCAL_TITLE = "tmux -CC on this machine";
  const REMOTE_TITLE = "tmux -CC from ssh geekom";
  const END_MESSAGE = "End the tmux server and every session it holds?";

  function entry(
    over: Partial<TmuxConnectionEntry> & Pick<TmuxConnectionEntry, "connection">,
  ): TmuxConnectionEntry {
    return {
      library_id: "local",
      origin: { program: "tmux", command: "tmux -CC", local: true },
      version: "3.5a",
      session: { id: "$0", name: "main" },
      windows: [],
      window_cap: 8,
      errors: [],
      control_window: `${over.connection}-control`,
      ...over,
    };
  }

  // A connection's rows as the library serves them: the control terminal
  // minted hidden with both marks, the windows plain terminal rows with the
  // connection's mark.
  function row(connection: string, window_id: string, control: boolean, ordinal: number): WindowRecord {
    return {
      window_id,
      library_id: "local",
      kind: "terminal",
      title: control ? "Control terminal" : `Terminal Window ${ordinal}`,
      ordinal,
      workspace_path: null,
      prefix: "t/tmux",
      token: "",
      persisted: false,
      connected: true,
      active_transfer: false,
      control,
      hidden: control,
      tmux: { connection, control },
    };
  }

  const local = entry({
    connection: "tm-local",
    windows: [{ id: "@0", name: "zsh", panes: 1, open: true, chan_window: "tm-local-w1" }],
  });
  const remote = entry({
    connection: "tm-geekom",
    origin: { program: "ssh", command: "ssh geekom", local: false },
    session: { id: "$2", name: "work" },
    windows: [
      { id: "@1", name: "vim", panes: 2, open: true, chan_window: "tm-geekom-w1" },
      { id: "@3", name: "logs", panes: 1, open: false },
    ],
  });
  const rows = [
    row("tm-local", "tm-local-control", true, 0),
    row("tm-local", "tm-local-w1", false, 1),
    row("tm-geekom", "tm-geekom-w1", false, 1),
    row("tm-geekom", "tm-geekom-control", true, 0),
  ];

  function card(title: string): HTMLElement {
    const s = [...(target?.querySelectorAll("section.machine") ?? [])].find((m) =>
      m.querySelector(".machine-header")?.textContent?.includes(title),
    );
    if (!s) throw new Error(`no card titled "${title}"`);
    return s as HTMLElement;
  }

  function rowNames(c: HTMLElement): string[] {
    return [...c.querySelectorAll(".term-list .row-name")].map((n) => n.textContent?.trim() ?? "");
  }

  beforeEach(async () => {
    const { setMockTmuxConnections } = await import("../api/mock");
    setMockTmuxConnections([local, remote], rows.map((r) => ({ ...r, tmux: { ...r.tmux! } })));
  });

  afterEach(async () => {
    const { setMockTmuxConnections } = await import("../api/mock");
    setMockTmuxConnections([], []);
  });

  it("deals one card per connection, titled by where tmux runs, with its rows off This machine", () => {
    mountList();
    const localCard = card(LOCAL_TITLE);
    const remoteCard = card(REMOTE_TITLE);
    expect(remoteCard.textContent).toContain("session work");
    expect(remoteCard.textContent).toContain("tmux 3.5a");
    expect(localCard.querySelector(".machine-icon.live")).not.toBeNull();
    // The control terminal is pinned first; the rows are the connection's,
    // and a tmux window past the cap closes the list.
    expect(localCard.querySelector(".section-label")?.textContent).toBe("Windows");
    expect(rowNames(localCard)).toEqual(["Control terminal", "Terminal Window 1"]);
    expect(rowNames(remoteCard)).toEqual(["Control terminal", "Terminal Window 1", "logs"]);
    // This machine lists neither the control terminals nor the tmux windows.
    const thisMachine = card("This machine");
    expect(thisMachine.textContent).not.toContain("Control terminal");
    expect(rowNames(thisMachine)).not.toContain("logs");
    expect(thisMachine.querySelector(".section-label")?.textContent).toBe("Terminals");
    // The badge counts the rows the card shows, the unopened window included.
    const badge = (c: HTMLElement) =>
      c.querySelector(".machine-actions .count-badge")?.getAttribute("title");
    expect(badge(localCard)).toBe("2 windows");
    expect(badge(remoteCard)).toBe("3 windows");
  });

  it("asks the connection for a new window with t and detaches with c", async () => {
    const { backend } = await import("../api/backend");
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    try {
      mountList();
      const newWindow = byAria(`New tmux window in ${REMOTE_TITLE}`)!;
      expect(newWindow.dataset.deckKey).toBe("t");
      newWindow.click();
      await settle();
      const detach = byAria(`Detach ${REMOTE_TITLE}`)!;
      expect(detach.dataset.deckKey).toBe("c");
      expect(detach.classList.contains("on")).toBe(true);
      detach.click();
      await settle();
      expect(request.mock.calls).toEqual([
        ["tm-geekom", { request: "new-window" }],
        ["tm-geekom", { request: "detach" }],
      ]);
      expect(library.error).toBeNull();
    } finally {
      request.mockRestore();
    }
  });

  it("asks before ending the tmux server, and ends only on confirm", async () => {
    const { backend } = await import("../api/backend");
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    try {
      mountList();
      const end = byAria(`End ${LOCAL_TITLE}`)!;
      // The power toggle has no letter: the keys stay the other cards' set.
      expect(end.hasAttribute("data-deck-key")).toBe(false);
      end.click();
      await settle();
      flushSync();
      expect(confirm.open).toBe(true);
      expect(confirm.message).toBe(END_MESSAGE);
      expect(request).not.toHaveBeenCalled();
      cancelConfirm();
      expect(request).not.toHaveBeenCalled();
      end.click();
      await settle();
      await resolveConfirm();
      expect(request).toHaveBeenCalledExactlyOnceWith("tm-local", { request: "end" });
    } finally {
      request.mockRestore();
    }
  });

  it("lists a tmux window past the cap as a hidden row whose show opens it", async () => {
    const { backend } = await import("../api/backend");
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    try {
      mountList();
      const logs = [...card(REMOTE_TITLE).querySelectorAll<HTMLElement>(".term-list .row")].find(
        (r) => r.textContent?.includes("logs"),
      )!;
      expect(logs.hasAttribute("data-deck-row")).toBe(true);
      expect(logs.textContent).toContain("@3");
      // No record, so nothing to focus; the one control is the show.
      expect(logs.querySelector('[aria-label="Focus window"]')).toBeNull();
      const show = logs.querySelector<HTMLButtonElement>("button[data-deck-key='h']")!;
      expect(show.getAttribute("aria-label")).toBe("Show tmux window logs");
      show.click();
      await settle();
      expect(request).toHaveBeenCalledExactlyOnceWith("tm-geekom", {
        request: "open-window",
        window: "@3",
      });
      // The window that is open (@1) is an ordinary row, not an unopened one.
      expect(byAria("Show tmux window vim")).toBeUndefined();
    } finally {
      request.mockRestore();
    }
  });

  it("drops the card when the connection ends and returns its control terminal to This machine", async () => {
    mountList();
    byAria(`End ${LOCAL_TITLE}`)!.click();
    await settle();
    await resolveConfirm();
    await settle();
    flushSync();
    expect(library.error).toBeNull();
    expect(
      [...target!.querySelectorAll("section.machine")].some((m) =>
        m.querySelector(".machine-header")?.textContent?.includes(LOCAL_TITLE),
      ),
    ).toBe(false);
    expect(card(REMOTE_TITLE)).toBeTruthy();
    // The mock turns the control row into a plain terminal, as the library
    // does when the connection ends, and the row files under This machine.
    const plain = library.windows.find((w) => w.window_id === "tm-local-control")!;
    expect(plain.tmux).toBeUndefined();
    expect(plain.control).toBe(false);
    expect(rowNames(card("This machine"))).toContain(windowRowLabel(plain));
  });

  it("renders rows that arrived before their record under a provisional card with no actions", async () => {
    const { setMockTmuxConnections } = await import("../api/mock");
    setMockTmuxConnections([], [row("tm-early", "tm-early-control", true, 0), row("tm-early", "tm-early-w1", false, 1)]);
    mountList();
    const early = card("tmux -CC");
    expect(early.querySelector(".machine-header .row-name")?.textContent).toBe("tmux -CC");
    expect(rowNames(early)).toEqual(["Control terminal", "Terminal Window 1"]);
    expect(early.querySelectorAll(".machine-actions button")).toHaveLength(0);
    expect(rowNames(card("This machine"))).not.toContain("Control terminal");
  });
});

// Selection across all three kinds is covered above (local + devserver) and in
// selection.svelte.test.ts; the served-kind check is exercised by the remote
// confirm test selecting/acting on api rows.
void isSelected;
