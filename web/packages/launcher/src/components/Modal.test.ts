// @vitest-environment jsdom
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal.svelte";

let target: HTMLDivElement;
let origin: HTMLButtonElement;
const mounted = new Set<ReturnType<typeof mount>>();
const children = createRawSnippet(() => ({
  render: () => '<div><input aria-label="Name" /><button class="last">Save</button><button disabled>Disabled</button></div>',
}));

beforeEach(() => {
  target = document.createElement("div");
  origin = document.createElement("button");
  document.body.append(origin, target);
  origin.focus();
});

afterEach(async () => {
  for (const instance of mounted) await unmount(instance);
  mounted.clear();
  target.remove();
  origin.remove();
});

function render(onclose = vi.fn(), title = "New workspace") {
  const instance = mount(Modal, { target, props: { title, onclose, children } });
  mounted.add(instance);
  flushSync();
  const panel = [...target.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
  return { instance, panel };
}

function press(element: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe("Modal keyboard", () => {
  it("takes focus into the panel on open", async () => {
    const { panel } = render();
    await tick();
    expect(document.activeElement).toBe(panel);
  });

  it("wraps Tab from the last enabled control to the header close button", () => {
    const { panel } = render();
    const last = panel.querySelector<HTMLButtonElement>(".last")!;
    last.focus();
    const tab = press(last);
    expect(document.activeElement).toBe(panel.querySelector(".modal-close"));
    expect(tab.defaultPrevented).toBe(true);
  });

  it("wraps Shift+Tab from the first control and from the panel", () => {
    const { panel } = render();
    const first = panel.querySelector<HTMLButtonElement>(".modal-close")!;
    for (const from of [first, panel]) {
      from.focus();
      const tab = press(from, true);
      expect(document.activeElement).toBe(panel.querySelector(".last"));
      expect(tab.defaultPrevented).toBe(true);
    }
  });

  it("answers one Escape in the focused dialog and stops it there", () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    render(firstClose);
    const { panel } = render(secondClose, "Confirm");
    const input = panel.querySelector("input")!;
    input.focus();
    const escaped = vi.fn();
    document.addEventListener("keydown", escaped);
    window.addEventListener("keydown", escaped);
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(secondClose).toHaveBeenCalledOnce();
      expect(firstClose).not.toHaveBeenCalled();
      expect(escaped).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      document.removeEventListener("keydown", escaped);
      window.removeEventListener("keydown", escaped);
    }
  });

  it("restores the opening control when the dialog closes", async () => {
    const { instance, panel } = render();
    panel.querySelector("input")!.focus();
    const restore = vi.spyOn(origin, "focus");
    await unmount(instance);
    mounted.delete(instance);
    expect(document.activeElement).toBe(origin);
    expect(restore).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("names each dialog by its own visible heading", () => {
    const first = render().panel;
    const second = render(vi.fn(), "Confirm").panel;
    for (const panel of [first, second]) {
      const id = panel.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)).toBe(panel.querySelector("h2"));
      expect(panel.getAttribute("aria-modal")).toBe("true");
    }
    expect(first.getAttribute("aria-labelledby")).not.toBe(second.getAttribute("aria-labelledby"));
  });

  it("keeps the backdrop out of the tab order and both close buttons clickable", () => {
    const close = vi.fn();
    const { panel } = render(close);
    const backdrop = target.querySelector<HTMLButtonElement>(".backdrop")!;
    expect(backdrop.tabIndex).toBe(-1);
    panel.querySelector<HTMLButtonElement>(".last")!.click();
    expect(close).not.toHaveBeenCalled();
    backdrop.click();
    panel.querySelector<HTMLButtonElement>(".modal-close")!.click();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("prevents a backdrop press from taking focus out of the panel", () => {
    const { panel } = render();
    const input = panel.querySelector("input")!;
    input.focus();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const backdrop = target.querySelector<HTMLButtonElement>(".backdrop")!;
    backdrop.dispatchEvent(event);
    // jsdom has no pointer default action; emulate the focus it would take.
    if (!event.defaultPrevented) backdrop.focus();
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });
});
