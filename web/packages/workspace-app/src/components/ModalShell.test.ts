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
  press,
  recordDocumentKeys,
  settle,
  unmountDialogs,
} from "../__tests__/dialog";

const body = createRawSnippet(() => ({
  render: () =>
    `<div><h2 id="probe-title">Probe</h2><p class="body-probe"><button type="button">Inside</button></p></div>`,
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
