// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resolveLink: vi.fn(async (target: string) => ({ path: target, kind: "file", is_dir: false })),
    },
  };
});

import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
});

test("an internal destination outside the workspace stays a broken, inert link pill", async () => {
  const onWikiClick = vi.fn();
  const { content } = await mountWysiwyg({
    value: "see [up](../../x.md)",
    currentPath: "notes/a.md",
    onWikiClick,
  });
  await settle(6);

  const pill = content.querySelector<HTMLElement>(".cm-md-wiki-pill");
  expect(pill?.dataset.refkind).toBe("broken");
  expect(pill?.textContent).toBe("up");
  expect(content.textContent).not.toContain("](");
  expect(content.querySelector(".cm-md-link")).toBeNull();
  pill!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
  expect(onWikiClick).not.toHaveBeenCalled();
});

test("a destination inside the workspace keeps its file pill", async () => {
  const { content } = await mountWysiwyg({
    value: "see [ok](b.md)",
    currentPath: "notes/a.md",
  });
  await settle(6);

  const pill = content.querySelector<HTMLElement>(".cm-md-wiki-pill");
  expect(pill?.dataset.refkind).toBe("file");
  expect(pill?.textContent).toBe("ok");
});
