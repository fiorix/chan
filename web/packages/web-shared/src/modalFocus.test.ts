// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createModalFocus } from "./modalFocus";

let target: HTMLDivElement;
afterEach(() => target.remove());

it("captures focus before mounting and restores it without scrolling", () => {
  target = document.createElement("div");
  target.innerHTML = '<button>Origin</button><div tabindex="-1"></div><input />';
  document.body.append(target);
  const origin = target.querySelector("button")!;
  const panel = target.querySelector("div")!;
  origin.focus();
  const focus = createModalFocus({ onClose: () => {} });
  target.querySelector("input")!.focus();
  const destroy = focus.mount(panel);
  expect(document.activeElement).toBe(panel);
  const restore = vi.spyOn(origin, "focus");
  destroy();
  expect(restore).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(document.activeElement).toBe(origin);
});

it("does not restore focus to an element that left the document", () => {
  target = document.createElement("div");
  target.innerHTML = '<button>Origin</button><div tabindex="-1"></div>';
  document.body.append(target);
  const origin = target.querySelector("button")!;
  origin.focus();
  const focus = createModalFocus({ onClose: () => {} });
  const destroy = focus.mount(target.querySelector("div")!);
  const restore = vi.spyOn(origin, "focus");
  origin.remove();
  destroy();
  expect(restore).not.toHaveBeenCalled();
});

it("lets a shell own restoration without disabling initial focus", () => {
  target = document.createElement("div");
  target.innerHTML = '<button>Origin</button><div tabindex="-1"></div>';
  document.body.append(target);
  const origin = target.querySelector("button")!;
  origin.focus();
  const focus = createModalFocus({ onClose: () => {}, restoreFocus: false });
  const panel = target.querySelector("div")!;
  const destroy = focus.mount(panel);
  expect(document.activeElement).toBe(panel);
  const restore = vi.spyOn(origin, "focus");
  destroy();
  expect(restore, "restoration opt-out").not.toHaveBeenCalled();
});

it("wraps forward and backward Tab from outside or the panel and retains an empty panel", () => {
  target = document.createElement("div");
  target.innerHTML = '<input /><div tabindex="-1"><button>First</button><button>Last</button></div>';
  document.body.append(target);
  const outside = target.querySelector("input")!;
  const panel = target.querySelector("div")!;
  const focus = createModalFocus({ onClose: () => {} });
  const destroy = focus.mount(panel);
  for (const from of [outside, panel]) for (const shiftKey of [false, true]) {
    from.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
    focus.onKeydown(event);
    expect(document.activeElement, "outside/panel Tab").toBe(panel.querySelectorAll("button")[shiftKey ? 1 : 0]);
    expect(event.defaultPrevented).toBe(true);
  }
  panel.replaceChildren(); outside.focus();
  focus.onKeydown(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
  expect(document.activeElement, "empty panel fallback").toBe(panel);
  destroy();
});
