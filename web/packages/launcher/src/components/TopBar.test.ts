// The desktop-surface top bar: the title block is the flip toggle between the
// Computers and Gateways screens. The initial labels stay the pinned
// "Computers" / "This machine & devservers" (App.test.ts), the toggle's
// aria-label sits outside every pinned set, and flipping drops select mode.
// The bridgeless surfaces are covered in TopBar.selfManaged.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import TopBar from "./TopBar.svelte";
import { screen } from "../state/screen.svelte";
import { selection, setSelectMode } from "../state/selection.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountBar(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(TopBar, { target });
}

function toggle(): HTMLButtonElement {
  return target!.querySelector("button.title-toggle") as HTMLButtonElement;
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
  screen.current = "computers";
  screen.flips = 0;
  setSelectMode(false);
});

describe("TopBar screen toggle (desktop surface)", () => {
  it("renders the Computers title as the flip toggle", () => {
    mountBar();
    expect(target!.textContent).toContain("Computers");
    expect(target!.textContent).toContain("This machine & devservers");
    expect(toggle()).not.toBeNull();
    expect(toggle().getAttribute("aria-label")).toBe("Show gateways");
    expect(target!.querySelector('[aria-label="Open command launcher"]')).not.toBeNull();
  });

  it("clicking the title flips to Gateways and back", () => {
    mountBar();
    toggle().click();
    flushSync();
    expect(screen.current).toBe("gateways");
    expect(screen.flips).toBe(1);
    expect(target!.textContent).toContain("Gateways");
    expect(target!.textContent).toContain("Connection to remote gateways");
    expect(toggle().getAttribute("aria-label")).toBe("Show computers");
    expect(target!.querySelector('[aria-label="Open command launcher"]')).toBeNull();

    toggle().click();
    flushSync();
    expect(screen.current).toBe("computers");
    expect(target!.textContent).toContain("This machine & devservers");
  });

  it("flipping drops select mode", () => {
    mountBar();
    setSelectMode(true);
    toggle().click();
    flushSync();
    expect(selection.selectMode).toBe(false);
  });
});
