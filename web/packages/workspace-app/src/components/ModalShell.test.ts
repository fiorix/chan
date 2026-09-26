// @vitest-environment jsdom
//
// ModalShell, mounted with a probe body: the panel it wraps the body in, the
// clicks that dismiss it and the ones that do not, and the keys and sizing a
// dialog hands it.

import { createRawSnippet, flushSync, mount, unmount, type Snippet } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import ModalShell from "./ModalShell.svelte";
import {
  backdropIn,
  clickBackdrop,
  dialogIn,
  dialogName,
  focusOrigin,
  mountDialog,
  pointerPress,
  press,
  recordDocumentKeys,
  settle,
  unmountDialogs,
} from "../__tests__/dialog";

const body = createRawSnippet(() => ({
  render: () =>
    `<div><h2 id="probe-title">Probe</h2><p class="body-probe"><button type="button">Inside</button></p></div>`,
}));

// A body with controls at both ends and one between them.
const controls = createRawSnippet(() => ({
  render: () =>
    `<div><h2 id="probe-title">Probe</h2><button type="button" class="first">First</button><input class="middle" /><button type="button" class="last">Last</button></div>`,
}));

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = mountDialog(ModalShell, {
    labelledby: "probe-title",
    onClose: () => {},
    children: body,
    ...props,
  });
  flushSync();
  return target;
}

afterEach(unmountDialogs);

describe("ModalShell", () => {
  test("wraps the body it is given in a dialog panel", () => {
    const target = render();
    const dialog = dialogIn(target)!;
    expect(dialog.querySelector(".body-probe button")?.textContent).toBe("Inside");
  });

  test("is a modal dialog named by the title its body marks", () => {
    const dialog = dialogIn(render())!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("Probe");
  });

  test("its backdrop is a button beside the panel, named Close and out of the tab order", () => {
    const target = render();
    const backdrop = backdropIn(target)!;
    expect(backdrop, "a backdrop button beside the dialog").not.toBeNull();
    expect(dialogIn(target)!.contains(backdrop)).toBe(false);
    expect(backdrop.getAttribute("aria-label")).toBe("Close");
    expect(backdrop.tabIndex).toBe(-1);
  });

  // jsdom does no hit-testing and applies no component CSS, so this pins the
  // structure the stacking rests on: both are positioned with no z-index, and
  // the later one paints on top. The browser smoke's dialog clicks prove the
  // real pointer hit.
  test("puts the panel after its backdrop, so the panel paints over it", () => {
    const target = render();
    const order = backdropIn(target)!.compareDocumentPosition(dialogIn(target)!);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING, "the panel follows the backdrop").toBeTruthy();
  });

  test("takes focus into the panel when it opens", async () => {
    focusOrigin();
    const dialog = dialogIn(render())!;
    await settle();
    expect(document.activeElement).toBe(dialog);
  });

  test("leaves focus on the control its body parks it on", async () => {
    focusOrigin();
    const parking: Snippet = createRawSnippet(() => ({
      render: () => `<div><h2 id="probe-title">Probe</h2><input class="field" /></div>`,
      setup: (el) => queueMicrotask(() => el.querySelector<HTMLInputElement>(".field")!.focus()),
    }));
    const dialog = dialogIn(render({ children: parking }))!;
    await settle();
    expect(document.activeElement).toBe(dialog.querySelector(".field"));
  });

  test("returns focus to where it was when it opened, once it closes", async () => {
    const origin = focusOrigin();
    const target = document.createElement("div");
    document.body.append(target);
    const shell = mount(ModalShell, {
      target,
      props: { labelledby: "probe-title", onClose: () => {}, children: body },
    });
    await settle();
    expect(document.activeElement, "the open dialog holds focus").not.toBe(origin);
    await unmount(shell);
    expect(document.activeElement).toBe(origin);
  });

  test("a click on the backdrop closes and a click inside the panel does not", () => {
    const onClose = vi.fn();
    const target = render({ onClose });
    dialogIn(target)!.querySelector("button")!.click();
    expect(onClose, "a click inside the panel").not.toHaveBeenCalled();
    clickBackdrop(target);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a press on the backdrop leaves focus in the panel, so Escape stays the dialog's", async () => {
    const onClose = vi.fn();
    const target = render({ onClose });
    await settle();
    const dialog = dialogIn(target)!;
    pointerPress(backdropIn(target)!);
    expect(dialog.contains(document.activeElement), "focus is inside the panel after the press").toBe(true);
    const reached = recordDocumentKeys();
    press(document.activeElement!, "Escape");
    reached.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reached.keys, "keys that reached the document").toEqual([]);
  });

  test("a press inside the panel released over the dim leaves it open", () => {
    const onClose = vi.fn();
    const target = render({ onClose });
    const dialog = dialogIn(target)!;
    dialog.querySelector("button")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdropIn(target)!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // The browser fires the click at the nearest ancestor of both ends.
    dialog.parentElement!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Escape anywhere in the panel closes it and goes no further", () => {
    const onClose = vi.fn();
    const onKeydown = vi.fn();
    const target = render({ onClose, onKeydown });
    const reached = recordDocumentKeys();
    const escape = press(dialogIn(target)!.querySelector("button")!, "Escape");
    reached.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(reached.keys, "keys that reached the document").toEqual([]);
    expect(onKeydown, "the dialog's own key handler").not.toHaveBeenCalled();
  });

  test("Tab past the last control wraps to the first", async () => {
    const dialog = dialogIn(render({ children: controls }))!;
    await settle();
    const last = dialog.querySelector<HTMLElement>(".last")!;
    last.focus();
    const tab = press(last, "Tab");
    expect(document.activeElement).toBe(dialog.querySelector(".first"));
    expect(tab.defaultPrevented, "the browser does not move focus again").toBe(true);
  });

  test("Shift+Tab before the first control, or from the panel itself, wraps to the last", async () => {
    const dialog = dialogIn(render({ children: controls }))!;
    await settle();
    const starts: Array<[string, HTMLElement]> = [
      ["the first control", dialog.querySelector<HTMLElement>(".first")!],
      ["the panel", dialog],
    ];
    for (const [name, from] of starts) {
      from.focus();
      const tab = press(from, "Tab", { shiftKey: true });
      expect(document.activeElement, `Shift+Tab from ${name}`).toBe(dialog.querySelector(".last"));
      expect(tab.defaultPrevented, `Shift+Tab from ${name}`).toBe(true);
    }
  });

  test("leaves Tab between the first and last controls to the browser", async () => {
    const dialog = dialogIn(render({ children: controls }))!;
    await settle();
    const first = dialog.querySelector<HTMLElement>(".first")!;
    first.focus();
    const tab = press(first, "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  test("leaves a Tab that a control inside already took to that control", async () => {
    // PathPromptModal's input takes Tab to complete a path.
    const completing: Snippet = createRawSnippet(() => ({
      render: () =>
        `<div><h2 id="probe-title">Probe</h2><button type="button" class="first">First</button><input class="last" /></div>`,
      setup: (el) => el.querySelector(".last")!.addEventListener("keydown", (e) => e.preventDefault()),
    }));
    const dialog = dialogIn(render({ children: completing }))!;
    await settle();
    const input = dialog.querySelector<HTMLElement>(".last")!;
    input.focus();
    press(input, "Tab");
    expect(document.activeElement).toBe(input);
  });

  test("keeps Tab on a panel with no controls", async () => {
    const bare: Snippet = createRawSnippet(() => ({ render: () => `<h2 id="probe-title">Probe</h2>` }));
    const dialog = dialogIn(render({ children: bare }))!;
    await settle();
    const tab = press(dialog, "Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  // A body whose last control in the DOM is not somewhere Tab stops.
  test.each([
    ["a button taken out of the order", `<button type="button" tabindex="-1">Copy</button>`],
    ["a hidden input", `<input hidden />`],
    ["a button in a container that is not displayed", `<span style="display: none"><button type="button">Gone</button></span>`],
    ["an invisible button", `<button type="button" style="visibility: hidden">Gone</button>`],
    ["a button in a disabled fieldset", `<fieldset disabled><button type="button">Off</button></fieldset>`],
    ["a button in an inert region", `<div inert><button type="button">Inert</button></div>`],
  ])("Tab past the last stop wraps to the first when %s trails it", async (_name, trailing) => {
    const trailed: Snippet = createRawSnippet(() => ({
      render: () =>
        `<div><h2 id="probe-title">Probe</h2><button type="button" class="first">First</button><button type="button" class="last">Last</button>${trailing}</div>`,
    }));
    const dialog = dialogIn(render({ children: trailed }))!;
    await settle();
    const last = dialog.querySelector<HTMLElement>(".last")!;
    last.focus();
    const tab = press(last, "Tab");
    expect(document.activeElement, "focus wraps to the first control").toBe(dialog.querySelector(".first"));
    expect(tab.defaultPrevented).toBe(true);
  });

  // Tab stops beyond buttons, links and form fields. jsdom cannot focus a
  // media element, so the wrap is read from the focus call.
  test.each([
    ["an editing host", `<div contenteditable="true" class="end">Notes</div>`],
    ["a details summary", `<details><summary class="end">More</summary>Body</details>`],
    ["an iframe", `<iframe class="end" title="Frame"></iframe>`],
    ["a video with controls", `<video controls class="end"></video>`],
    ["an audio player with controls", `<audio controls class="end"></audio>`],
  ])("Shift+Tab from the panel wraps to %s that ends it", async (_name, ending) => {
    const ended: Snippet = createRawSnippet(() => ({
      render: () =>
        `<div><h2 id="probe-title">Probe</h2><button type="button" class="first">First</button>${ending}</div>`,
    }));
    const dialog = dialogIn(render({ children: ended }))!;
    await settle();
    const end = dialog.querySelector<HTMLElement>(".end")!;
    const focus = vi.spyOn(end, "focus");
    const tab = press(dialog, "Tab", { shiftKey: true });
    expect(focus, "focus wraps to the control that ends the panel").toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(true);
  });

  test("hands Tab to the dialog before wrapping it, and leaves a Tab the dialog took", async () => {
    let focusedWhenAsked: Element | null = null;
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      focusedWhenAsked = document.activeElement;
      e.preventDefault();
    };
    const dialog = dialogIn(render({ children: controls, onKeydown }))!;
    await settle();
    const last = dialog.querySelector<HTMLElement>(".last")!;
    last.focus();
    press(last, "Tab");
    expect(focusedWhenAsked, "the dialog sees Tab where the press landed").toBe(last);
    expect(document.activeElement, "the shell leaves the dialog's Tab alone").toBe(last);
  });

  test("hands the dialog every other key pressed inside the panel", () => {
    const onKeydown = vi.fn();
    const target = render({ onKeydown });
    press(dialogIn(target)!.querySelector("button")!, "Enter");
    expect(onKeydown).toHaveBeenCalledTimes(1);
    expect((onKeydown.mock.calls[0]![0] as KeyboardEvent).key).toBe("Enter");
  });

  test("sizes the panel with the minimum width and row gap it is given", () => {
    const sized = dialogIn(render({ minWidth: "420px", gap: "0.55rem" }))!;
    expect([sized.style.minWidth, sized.style.gap]).toEqual(["420px", "0.55rem"]);
    const plain = dialogIn(render())!;
    expect([plain.style.minWidth, plain.style.gap]).toEqual(["", ""]);
  });
});
