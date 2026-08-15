// Component test: the shared WindowRow. The mutable surface renders [FOCUS] +
// [SHOW/HIDE] (Eye visible / EyeOff hidden); `icon` adds a leading kind glyph and
// the control terminal's amber "not responding..." pill + eye flash when its library
// needs attention. Exercises the real Svelte 5 runtime per jsdom. The read-only
// surface (static dot, no actions) is covered in LibraryReadOnly.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import WindowRow from "./WindowRow.svelte";
import { controlAttention, clearAllControlAttention } from "../state/controlAttention.svelte";
import { library } from "../state/library.svelte";
import type { DevserverEntry, WindowRecord } from "../api/library";

function ds(status: DevserverEntry["status"], library_id: string): DevserverEntry {
  return {
    id: "d1",
    host: "h",
    port: 1,
    label: "",
    script: "",
    has_token: false,
    library_id,
    status,
    native_trust_required: false,
  } as unknown as DevserverEntry;
}

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

function win(
  over: Partial<WindowRecord> & Pick<WindowRecord, "window_id" | "library_id">,
): WindowRecord {
  return {
    kind: "terminal",
    title: "",
    ordinal: 1,
    workspace_path: null,
    prefix: "",
    token: "",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
    ...over,
  };
}

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(w: WindowRecord, props: { icon?: boolean } = {}): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(WindowRow, { target, props: { w, ...props } });
  return target;
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  clearAllControlAttention();
  library.devservers = [];
});

describe("WindowRow", () => {
  it("renders an iconless mutable row: focus + hide, no glyph, no dot, no pill", () => {
    const el = render(win({ window_id: "w", library_id: "local" }));
    expect(el.querySelector('[aria-label="Focus window"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Hide window"]')).not.toBeNull();
    expect(el.querySelector(".row-glyph")).toBeNull();
    expect(el.querySelector(".dot")).toBeNull();
    expect(el.textContent).not.toContain("disconnected");
  });

  it("renders a leading glyph and a path-free 'Window N' label for a workspace window", () => {
    const el = render(
      win({ window_id: "w", library_id: "local", kind: "workspace", workspace_path: "/p", ordinal: 1 }),
      { icon: true },
    );
    expect(el.querySelector(".row-glyph")).not.toBeNull();
    // The window row no longer repeats the workspace path (the card carries it),
    // and the label drops the base prefix -- just "Window N".
    expect(el.querySelector(".row-sub")).toBeNull();
    expect(el.textContent).toContain("Window 1");
    expect(el.textContent).not.toContain("/p");
  });

  it("edits and persists user text beside a workspace Window N label", async () => {
    const { backend } = await import("../api/backend");
    const save = vi.spyOn(backend, "setWindowLabel").mockResolvedValue(undefined);
    const el = render(
      win({
        window_id: "workspace-label",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p",
        ordinal: 2,
        label: "old text",
        prefix: "p",
      }),
    );
    const label = el.querySelector(
      'button[title="Add or edit window text"]',
    ) as HTMLButtonElement;
    expect(label.textContent).toBe("Window 2 [old text]");
    label.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const input = el.querySelector(
      'input[aria-label="Text for Window 2"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("old text");
    expect(input.maxLength).toBe(64);
    input.value = "release checks";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledWith(
      "workspace-label",
      "release checks",
      undefined,
    );
    save.mockRestore();
  });

  it("edits and persists up to 64 characters beside a Terminal Window N label", async () => {
    const { backend } = await import("../api/backend");
    const save = vi.spyOn(backend, "setWindowLabel").mockResolvedValue(undefined);
    const el = render(
      win({
        window_id: "terminal-label",
        library_id: "local",
        ordinal: 4,
        label: "deploy shell",
      }),
    );
    const label = el.querySelector(
      'button[title="Add or edit window text"]',
    ) as HTMLButtonElement;
    expect(label.textContent).toBe("Terminal Window 4 [deploy shell]");
    label.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const input = el.querySelector(
      'input[aria-label="Text for Terminal Window 4"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("deploy shell");
    expect(input.maxLength).toBe(64);
    const maxLengthLabel = "x".repeat(64);
    input.value = maxLengthLabel;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledWith("terminal-label", maxLengthLabel, undefined);
    save.mockRestore();
  });

  it("does not offer custom text editing on generated control terminals", () => {
    const el = render(
      win({ window_id: "control-label", library_id: "lib-remote", control: true }),
    );
    expect(el.textContent).toContain("Control terminal");
    expect(el.querySelector('button[title="Add or edit window text"]')).toBeNull();
  });

  it("a hidden window shows the Show (EyeOff) toggle", () => {
    const el = render(win({ window_id: "h", library_id: "local", hidden: true }));
    expect(el.querySelector('[aria-label="Show window"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Hide window"]')).toBeNull();
  });

  it("flashes the control eye, with no text pill, when its library needs attention", () => {
    controlAttention.libs["lib-x"] = true;
    const el = render(win({ window_id: "c", library_id: "lib-x", control: true }), { icon: true });
    const eye = el.querySelector("button.icon-btn.attention");
    expect(eye).not.toBeNull();
    expect(eye!.getAttribute("aria-label")).toContain("needs attention");
    // The textual "connection lost" cue is the devserver identity row's machine
    // icon turned red (Library.svelte), not a pill on this row.
    expect(el.textContent).not.toContain("not responding...");
    expect(el.textContent).not.toContain("connection closed");
    expect(el.querySelector(".row-glyph.control")).not.toBeNull();
  });

  it("flashes the eye when the owning devserver is DISCONNECTED (script died)", () => {
    // A control script died: the devserver is disconnected but its control
    // terminal is kept alive at "process exited". The control record's own
    // `connected` stays true (/ws-socket presence); the desktop emits attention
    // for this case too, so the eye flash keys on the attention state alone.
    library.devservers = [ds("disconnected", "lib-x")];
    controlAttention.libs["lib-x"] = true;
    const el = render(
      win({ window_id: "c", library_id: "lib-x", control: true, connected: true }),
      { icon: true },
    );
    expect(el.querySelector("button.icon-btn.attention")).not.toBeNull();
  });

  it("flashes the eye when the owning devserver is CONNECTED but not responding", () => {
    library.devservers = [ds("connected", "lib-x")];
    controlAttention.libs["lib-x"] = true;
    const el = render(
      win({ window_id: "c", library_id: "lib-x", control: true, connected: true }),
      { icon: true },
    );
    expect(el.querySelector("button.icon-btn.attention")).not.toBeNull();
  });

  it("does NOT flash a healthy control terminal with no attention event", () => {
    const el = render(
      win({ window_id: "c", library_id: "lib-x", control: true, connected: true }),
      { icon: true },
    );
    expect(el.querySelector("button.icon-btn.attention")).toBeNull();
  });

  it("keeps control attention when focus fails", async () => {
    const { backend } = await import("../api/backend");
    const open = vi.spyOn(backend, "openWindow").mockRejectedValueOnce(new Error("stale window"));
    controlAttention.libs["lib-x"] = true;
    const el = render(win({ window_id: "c", library_id: "lib-x", control: true }), { icon: true });

    (el.querySelector('[aria-label="Focus window"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(controlAttention.libs["lib-x"]).toBe(true);
    expect(el.querySelector("button.icon-btn.attention")).not.toBeNull();
    open.mockRestore();
  });

  it("FOCUS drives openWindow through the bridge", async () => {
    const { backend } = await import("../api/backend");
    const open = vi.spyOn(backend, "openWindow");
    const el = render(win({ window_id: "w-local-term-1", library_id: "local" }));
    (el.querySelector('[aria-label="Focus window"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});
