// @vitest-environment jsdom
//
// A bubble is anchored at its trigger's position. A press on a link pill
// opens the wiki bubble while the pill stays drawn under the held button, and
// the release shows the link's source, which moves the trigger: the bubble
// re-reads its anchor then.

import { afterEach, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      linkTargets: vi.fn(async () => []),
      list: vi.fn(async () => []),
      resolveLink: vi.fn(async (target: string) => ({ path: target, kind: "file", is_dir: false })),
    },
  };
});

import { mouseDown, mouseUp } from "../__tests__/pointer";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const DOC = "see [notes](notes.md) for more";
const LINK = DOC.indexOf("[");
const URL_START = DOC.indexOf("notes.md");

/// The element the open bubble is positioned under.
function bubbleAnchor(): HTMLElement | undefined {
  return Array.from(document.body.children).find(
    (el): el is HTMLElement => el instanceof HTMLElement && el.style.position === "absolute" && el.style.width === "1px",
  );
}

test("a link pill's bubble re-anchors at the press's release, at the URL its source shows", async () => {
  const { view, content } = await mountWysiwyg({ value: DOC, currentPath: "a.md" });
  view.dispatch({ selection: { anchor: 0 } });
  await settle(6);
  const pill = content.querySelector<HTMLElement>(".cm-md-wiki-pill");
  expect(pill, "the link renders as a pill").not.toBeNull();
  // jsdom lays out nothing. While the pill is drawn every position inside
  // it sits at its left edge; once the source shows, each character of the
  // link takes 8 pixels from there.
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => {
    const left = content.querySelector(".cm-md-wiki-pill") ? 40 : 40 + 8 * (pos - LINK);
    return { left, right: left, top: 10, bottom: 26 };
  });

  mouseDown(pill!);
  await settle();

  expect(document.body.querySelector(".md-wiki-bubble"), "the press opens the bubble").not.toBeNull();
  expect(bubbleAnchor()?.style.left).toBe("40px");

  mouseUp(pill!);

  expect(content.querySelector(".cm-md-wiki-pill")).toBeNull();
  expect(bubbleAnchor()?.style.left).toBe(`${40 + 8 * (URL_START - LINK)}px`);
});
