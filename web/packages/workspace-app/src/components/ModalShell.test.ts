// @vitest-environment jsdom
//
// ModalShell, mounted with a probe body: the panel it wraps the body in, the
// clicks that dismiss it and the ones that do not, and the keys and sizing a
// dialog hands it.

import { createRawSnippet, flushSync } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import ModalShell from "./ModalShell.svelte";
import { clickBackdrop, dialogIn, mountDialog, press, unmountDialogs } from "../__tests__/dialog";

const body = createRawSnippet(() => ({
  render: () => `<p class="body-probe"><button type="button">Inside</button></p>`,
}));

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = mountDialog(ModalShell, { onClose: () => {}, children: body, ...props });
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

  test("a click on the backdrop closes and a click inside the panel does not", () => {
    const onClose = vi.fn();
    const target = render({ onClose });
    dialogIn(target)!.querySelector("button")!.click();
    expect(onClose, "a click inside the panel").not.toHaveBeenCalled();
    clickBackdrop(target);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("hands the dialog every key pressed inside the panel", () => {
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
