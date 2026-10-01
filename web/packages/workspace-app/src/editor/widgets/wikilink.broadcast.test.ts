// @vitest-environment jsdom
//
// Link kinds that resolve together repaint a rendered editor once. The link
// resolver is stubbed with promises the test holds, so the test decides when
// each target's kind settles.

import type { StateEffect } from "@codemirror/state";
import { afterEach, expect, test, vi } from "vitest";

const pending = vi.hoisted(() => new Map<string, () => void>());

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resolveLink: vi.fn(
        (target: string) =>
          new Promise((resolve) => {
            pending.set(target, () => resolve({ path: target, kind: "file", is_dir: false }));
          }),
      ),
    },
  };
});

import { kindResolvedEffect } from "./wikilink";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

// The kind cache lives as long as the module, so each run links targets no
// earlier run resolved.
let run = 0;

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
  pending.clear();
});

function kinds(content: HTMLElement): Array<string | undefined> {
  return [...content.querySelectorAll<HTMLElement>(".cm-md-wiki-pill")].map((pill) => pill.dataset.refkind);
}

function isKindRepaint(spec: unknown): boolean {
  const effects = (spec as { effects?: StateEffect<unknown> | readonly StateEffect<unknown>[] } | undefined)?.effects;
  const list = effects === undefined ? [] : Array.isArray(effects) ? effects : [effects];
  return list.some((effect: StateEffect<unknown>) => effect.is(kindResolvedEffect));
}

test("links whose kinds resolve together repaint the editor once", async () => {
  run += 1;
  const { view, content } = await mountWysiwyg({
    value: `see [one](burst-${run}-one.md), [two](burst-${run}-two.md) and [three](burst-${run}-three.md)`,
    currentPath: "notes/a.md",
  });
  await settle(6);
  expect(pending.size).toBe(3);
  expect(kinds(content)).toEqual([undefined, undefined, undefined]);

  const dispatch = vi.spyOn(view, "dispatch");
  for (const resolveKind of pending.values()) resolveKind();
  await settle(6);
  // The repaint waits for an animation frame.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await settle();

  const repaints = (dispatch.mock.calls as unknown[][]).filter(([spec]) => isKindRepaint(spec)).length;
  expect(kinds(content)).toEqual(["file", "file", "file"]);
  expect(repaints).toBe(1);
});
