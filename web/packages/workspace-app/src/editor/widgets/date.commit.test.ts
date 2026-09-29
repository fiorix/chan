// @vitest-environment jsdom
//
// A date re-picked from its pill replaces the date and nothing else: the
// text after it (a space, punctuation, the end of the line) is left as it
// was.

import { afterEach, describe, expect, test, vi } from "vitest";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mousedown(el: Element): void {
  el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
}

/// Open `value`, click its date pill and pick the 12th of the pill's month.
async function repick(value: string): Promise<string> {
  const { view } = await mountWysiwyg({ value, currentPath: "note.md" });
  view.dispatch({ selection: { anchor: 0 } });
  await settle();
  const pill = document.querySelector(".cm-md-date-pill");
  expect(pill, "the date renders as a pill").not.toBeNull();
  mousedown(pill!);
  await settle();
  const day = [...document.querySelectorAll(".md-date-popover button.md-date-day")].find(
    (b) => b.textContent === "12",
  );
  expect(day, "the calendar shows the 12th").toBeTruthy();
  mousedown(day!);
  await settle();
  return view.state.doc.toString();
}

describe("a date re-picked from its pill", () => {
  test("keeps the punctuation after it attached", async () => {
    expect(await repick("due 2026-08-11, soon")).toBe("due 2026-08-12, soon");
  });

  test("adds no space at the end of a line", async () => {
    expect(await repick("due 2026-08-11")).toBe("due 2026-08-12");
  });

  test("keeps the space that follows it", async () => {
    expect(await repick("due 2026-08-11 soon")).toBe("due 2026-08-12 soon");
  });
});
