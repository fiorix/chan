// @vitest-environment jsdom
//
// A press on a wiki pill places the caret inside its source under the
// editor's pointer hold: the pill stays drawn while the button is held and
// its source shows at the release.

import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resolveLink: vi.fn(async (target: string) => ({ path: `${target}.md`, kind: "file", is_dir: false })),
    },
  };
});

import { mouseDown, mouseUp } from "../../__tests__/pointer";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
});

const DOC = "see [[notes]] for more";

test("keeps the pill drawn while held and shows its source at the release, the caret before the closing brackets", async () => {
  const { view, content } = await mountWysiwyg({ value: DOC, currentPath: "a.md" });
  view.dispatch({ selection: { anchor: 0 } });
  await settle(6);
  const pill = content.querySelector<HTMLElement>(".cm-md-wiki-pill");
  expect(pill, "the link renders as a pill").not.toBeNull();

  mouseDown(pill!);

  expect(content.querySelector(".cm-md-wiki-pill")).toBe(pill);
  expect(view.state.selection.main.head).toBe(DOC.indexOf("]]"));

  mouseUp(pill!);

  expect(content.querySelector(".cm-md-wiki-pill")).toBeNull();
  expect(content.textContent).toContain("[[notes]]");
  expect(view.state.selection.main.head).toBe(DOC.indexOf("]]"));
});
