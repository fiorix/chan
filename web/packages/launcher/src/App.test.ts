// Smoke test: the launcher root mounts and renders its top bar with the
// command + Select controls and the New-workspace button. Registry/feed rendering loads
// asynchronously from the backend and is covered by the state + component
// tests; this keeps the mount path itself green. Also covers the error
// notice bubble's Dismiss -- a real component mount, since an error with no
// way to clear it short of a reload was the reported bug.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "./App.svelte";
import appSource from "./App.svelte?raw";
import { library, reportError } from "./state/library.svelte";
import { clearNotices } from "./state/notices.svelte";
import { screen } from "./state/screen.svelte";
import { controlAttention, clearAllControlAttention } from "./state/controlAttention.svelte";
import {
  activeCommandLauncherDraft,
  clearCommandLauncherDraft,
  closeCommandLauncher,
  commandLauncher,
  openCommandLauncher,
} from "./state/commandLauncher.svelte";
import { applyTheme, themeState } from "./state/theme.svelte";

// Pin the in-memory mock as the backend so loadLibrary succeeds (no spurious
// error banner from a failed fetch) and the banner test controls library.error.
vi.mock("./api/backend", async () => {
  const { mockApi } = await import("./api/mock");
  return { backend: mockApi };
});

// A macrotask hop lets the onMount loadLibrary fully settle before we assert.
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("launcher root", () => {
  let target: HTMLElement | null = null;
  let app: Record<string, unknown> | null = null;

  afterEach(() => {
    if (app) unmount(app);
    target?.remove();
    target = null;
    app = null;
    library.error = null;
    clearNotices();
    clearAllControlAttention();
    screen.current = "computers";
    screen.flips = 0;
    commandLauncher.entryMode = "computers";
    closeCommandLauncher();
    clearCommandLauncherDraft("computers");
    themeState.theme = "dark";
    applyTheme();
  });

  it("renders the top bar: title, subtitle, matching command icon, and no theme or [+]", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });

    const topbar = target.querySelector(".topbar")!;
    expect(topbar).not.toBeNull();
    expect(topbar.textContent).toContain("Computers");
    expect(topbar.textContent).toContain("This machine & devservers");
    expect(target.querySelector('[aria-label="Toggle theme"]')).toBeNull();
    const command = target.querySelector('[aria-label="Open command launcher"]');
    expect(command).not.toBeNull();
    // Match the pane hamburger's Command icon, including its lighter stroke.
    expect(command?.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.75");
    // The Gmail-style Select-mode toggle (reveals the row checkboxes).
    expect(topbar.querySelector("button.select")).not.toBeNull();
    // The add-workspace / add-devserver / open-terminal entry points all moved
    // into the library tree, so the top bar carries no [+] or terminal action.
    expect(topbar.querySelector('[aria-label="New workspace"]')).toBeNull();
    expect(topbar.querySelector('[aria-label="New local workspace"]')).toBeNull();
    expect(topbar.querySelector('[aria-label="Open terminal"]')).toBeNull();
    expect(topbar.querySelector('[aria-label="New local terminal"]')).toBeNull();
  });

  it("switches theme from the Desktop Computers launcher and dismisses it", async () => {
    themeState.theme = "dark";
    applyTheme();
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });
    await settle();

    openCommandLauncher("computers");
    flushSync();
    expect(
      target.querySelectorAll('[role="dialog"][aria-label="Command launcher"]'),
    ).toHaveLength(1);
    const input = target.querySelector(".deck-input") as HTMLInputElement;
    input.value = "theme";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "theme" }));
    await settle();
    flushSync();

    const themeCommand = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
      (button) => button.querySelector(".deck-result-title")?.textContent === "Switch to light theme",
    );
    expect(themeCommand).toBeTruthy();
    themeCommand?.click();
    await settle();
    flushSync();

    expect(themeState.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("renders the Local new-terminal + new-workspace actions and the add-devserver button once loaded", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });
    await settle();
    flushSync();

    // The open-terminal + new-workspace actions live in the Local group header.
    expect(target.querySelector('[aria-label="New local terminal"]')).not.toBeNull();
    expect(target.querySelector('[aria-label="New local workspace"]')).not.toBeNull();
    // The decoupled add-devserver entry is the bottom dashed button in the tree.
    const addDs = [...target.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add devserver"),
    );
    expect(addDs).toBeTruthy();
  });

  it("shows a dismissable error bubble that Dismiss clears (no reload needed)", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });
    // Let the mock loadLibrary settle (it nulls error on success), then raise
    // an error the way a failed action would.
    await settle();
    flushSync();

    reportError(new Error("the control terminal was closed before the devserver connected"));
    flushSync();

    const bubble = target.querySelector('.notice-bubble[role="alert"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.textContent).toContain("control terminal");
    const dismiss = bubble!.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    expect(dismiss).toBeTruthy();

    dismiss.click();
    flushSync();
    expect(target.querySelector('.notice-bubble[role="alert"]')).toBeNull();
  });

  it("flipping swaps Library for the gateways screen and labels the back face", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });
    await settle();
    flushSync();

    const flipLabel = (): string | null =>
      target!.querySelector(".screen-flip-inner")?.getAttribute("data-flip-label") ?? null;
    const toggle = (): void => {
      (target!.querySelector("button.title-toggle") as HTMLButtonElement).click();
      flushSync();
    };

    // Computers side: the library tree renders, no gateways section, and the
    // back face carries the CURRENT screen's name (showScreen mutates
    // screen.current before the turn plays, so the just-set screen is the
    // incoming face -- the label must read as the destination).
    expect(target.querySelector("section.machine")).not.toBeNull();
    expect(target.querySelector(".gateways-screen")).toBeNull();
    expect(flipLabel()).toBe("Computers");

    toggle();
    expect(target.querySelector(".gateways-screen")).not.toBeNull();
    expect(target.querySelector("section.machine")).toBeNull();
    expect(flipLabel()).toBe("Gateways");

    toggle();
    expect(target.querySelector(".gateways-screen")).toBeNull();
    expect(target.querySelector("section.machine")).not.toBeNull();
    expect(flipLabel()).toBe("Computers");
  });

  it("subscribes the desktop's structured launcher-notice event", () => {
    // jsdom has no Tauri event bridge, so the wiring is source-pinned: the
    // structured notices channel must stay subscribed alongside auth-error.
    expect(appSource).toContain('onTauriEvent<Notice>("launcher-notice", pushNotice)');
    expect(appSource).toContain('onTauriEvent<string>("auth-error", reportError)');
  });

  it("does not clear existing control attention on the first connected snapshot", async () => {
    const libId = "lib-7f3a9c21b40d8e65";
    controlAttention.libs[libId] = true;
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });

    await settle();
    flushSync();

    expect(controlAttention.libs[libId]).toBe(true);
  });
});

// The update-ready dialog is the only surface a user sees for the desktop
// updater, so both copy branches and the restart outcome are pinned through
// a stubbed Tauri bridge: `installed:false` (the Windows staged download) and
// the bare-string rejection a Tauri `Err(String)` produces.
describe("launcher update dialog", () => {
  type Handler = (event: { payload: unknown }) => void;
  let target: HTMLElement | null = null;
  let app: Record<string, unknown> | null = null;
  let handlers: Record<string, Handler> = {};

  function stubTauri(invoke: (cmd: string) => Promise<unknown>): void {
    handlers = {};
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        event: {
          listen: (name: string, cb: Handler) => {
            handlers[name] = cb;
            return Promise.resolve(() => {});
          },
        },
        core: { invoke: (cmd: string) => invoke(cmd) },
      },
    });
  }

  afterEach(() => {
    if (app) unmount(app);
    target?.remove();
    target = null;
    app = null;
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    clearNotices();
  });

  async function mountWithUpdate(payload: { version: string; installed?: boolean }) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target });
    await settle();
    flushSync();
    const ready = handlers["desktop-update-ready"];
    expect(ready, "the launcher subscribes desktop-update-ready").toBeTruthy();
    ready!({ payload });
    flushSync();
  }

  it("installed:false shows the staged copy and surfaces a bare-string rejection", async () => {
    stubTauri(() =>
      Promise.reject("no downloaded update is staged; relaunch chan-desktop to check again"),
    );
    await mountWithUpdate({ version: "0.95.0", installed: false });
    const copy = target!.querySelector(".update-copy")?.textContent ?? "";
    expect(copy).toContain("Restart now to install it.");
    expect(copy).not.toContain("apply on the next launch");
    const restart = target!.querySelector(".update-actions button.primary") as HTMLButtonElement;
    restart.click();
    await settle();
    flushSync();
    const alert = target!.querySelector(".update-error[role=\"alert\"]")?.textContent ?? "";
    expect(alert).toContain("no downloaded update is staged");
    expect(restart.disabled).toBe(false);
  });

  it("a payload without `installed` keeps the installed copy and restarts", async () => {
    stubTauri(() => Promise.resolve(undefined));
    await mountWithUpdate({ version: "0.95.0" });
    const copy = target!.querySelector(".update-copy")?.textContent ?? "";
    expect(copy).toContain("will apply on the next launch.");
    const restart = target!.querySelector(".update-actions button.primary") as HTMLButtonElement;
    restart.click();
    await settle();
    flushSync();
    expect(target!.querySelector(".update-error")).toBeNull();
    expect(restart.disabled).toBe(true);
  });
});
