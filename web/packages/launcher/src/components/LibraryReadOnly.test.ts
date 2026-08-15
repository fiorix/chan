// Read-only surface (gateway/devserver, no desktop bridge): the Library shows
// the on-state statically with NO mutation controls -- no new-workspace /
// new-terminal, no add-devserver, no checkboxes, no on/off or open-window, no
// connect/disconnect, and no edit-config affordance (the devserver header is a
// static identity, not a click target). A card can still expand to read its
// windows (static rows with the connection dot). `readOnly` is a boot-time
// const, so it is pinned via a module mock for the whole file. The mutable
// surface is covered in Library.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Library from "./Library.svelte";
import { library, loadLibrary, stopWatching } from "../state/library.svelte";
import { collapsedState } from "../state/machineCollapse.svelte";
import type { DevserverEntry } from "../api/library";

// Force the read-only surface for the whole file (hoisted before the imports):
// no registry mutation, no desktop bridge, not self-managed.
vi.mock("../state/capabilities", () => ({
  readOnly: true,
  canMutateRegistry: false,
  hasDesktopBridge: false,
  selfManagedWindows: false,
  hostOs: "linux",
}));

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

function labels(): string[] {
  return [...(target?.querySelectorAll("button[aria-label]") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
}

beforeEach(async () => {
  const { resetMockRemoteWorkspaces } = await import("../api/mock");
  resetMockRemoteWorkspaces();
  await loadLibrary();
});

afterEach(() => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
});

describe("Library read-only parity", () => {
  it("hides every mutation control including edit-config, keeps the static on-state", () => {
    mountList();
    const l = labels();
    // No add entry points (new workspace/terminal, add devserver).
    expect(l.some((x) => x.startsWith("New local"))).toBe(false);
    expect(l.some((x) => x.startsWith("New terminal on"))).toBe(false);
    expect(
      [...target!.querySelectorAll("button")].some((b) => b.textContent?.includes("Add devserver")),
    ).toBe(false);
    // No selection checkboxes.
    expect(target!.querySelector('input[type="checkbox"]')).toBeNull();
    // No on/off, connect/disconnect, or open-window actions.
    expect(l.some((x) => x.startsWith("Turn off") || x.startsWith("Turn on"))).toBe(false);
    expect(l.some((x) => x.startsWith("Disconnect ") || x.startsWith("Connect "))).toBe(false);
    expect(l.some((x) => x.startsWith("New window of"))).toBe(false);
    // No edit-config affordance on read-only (the devserver header is static).
    expect(l.some((x) => x.startsWith("Edit config") || x.startsWith("Settings for"))).toBe(false);
    // The devserver identity still renders (name + address), just not clickable.
    expect(target!.textContent).toContain("box.example.com:8787");
    // The workspace on-state shows as a static pill.
    expect(target!.querySelector(".pill")).not.toBeNull();
  });

  it("renders window rows statically with the connection dot, no focus/hide", () => {
    mountList();
    expect(target!.querySelector(".dot")).not.toBeNull();
    expect(target!.querySelector('[aria-label="Focus window"]')).toBeNull();
    expect(target!.querySelector('[aria-label="Hide window"]')).toBeNull();
  });

  it("shows the red lost icon for an unreachable devserver on the gateway surface", () => {
    // The gateway (read-only) surface is where a post-sleep unreachable devserver
    // appears; the honest red icon comes from the status field, no mutation
    // controls involved.
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "unreachable" } : d),
    );
    mountList();
    const prod = [...target!.querySelectorAll("section.machine")].find((m) =>
      m.textContent?.includes("box.example.com:8787"),
    );
    expect(prod).toBeTruthy();
    expect(prod!.querySelector(".ds-glyph.lost")).not.toBeNull();
    expect(prod!.querySelector(".ds-glyph.live")).toBeNull();
    expect(prod!.textContent).not.toContain("Not connected");
  });

  it("keeps the machine-collapse toggle: it is not a mutation control", () => {
    // The collapse toggle renders OUTSIDE the readOnly mutation guard, so a
    // gateway viewer can still fold a machine's windows. Its prefix-safe
    // aria-label must not read as a mutation control.
    collapsedState.keys = [];
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      mountList();
      // Scope to the local section: other machine cards keep their own content.
      const localSection = (): HTMLElement =>
        [...target!.querySelectorAll("section.machine")].find((m) =>
          m.textContent?.includes("This machine"),
        ) as HTMLElement;
      const toggle = localSection().querySelector(
        ".machine-actions .count-badge",
      ) as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute("aria-label")).toBe("Collapse windows of This machine");
      expect(localSection().querySelector(".machine-content")).not.toBeNull();
      toggle.click();
      flushSync();
      // Folded to the header row; the local content is gone.
      expect(localSection().querySelector(".machine-content")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      collapsedState.keys = [];
    }
  });
});
