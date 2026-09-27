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
