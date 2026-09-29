// @vitest-environment jsdom
//
// The overlay panel (search, Settings) is a named non-modal dialog. Closing it
// hands focus back to the element that held it when the panel opened, unless
// something else took focus in the meantime, such as a file a search result
// opened.

import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import OverlayShell from "./OverlayShell.svelte";
import { searchPanel } from "../state/store.svelte";
import { focusOrigin, settle } from "../__tests__/dialog";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  searchPanel.open = false;
  flushSync();
  for (const view of mounted.splice(0)) unmount(view);
  document.body.replaceChildren();
});

async function openSearchShell(): Promise<HTMLElement> {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(
    mount(OverlayShell, {
      target,
      props: {
        id: "search",
        label: "Search",
        get open() {
          return searchPanel.open;
        },
        onClose: () => {
          searchPanel.open = false;
        },
        children: createRawSnippet(() => ({ render: () => '<input aria-label="query" />' })),
      },
    }),
  );
  searchPanel.open = true;
  await settle();
  return target;
}

describe("the overlay panel", () => {
  test("hands focus back to where it was when it closes", async () => {
    const origin = focusOrigin();
    const target = await openSearchShell();
    target.querySelector<HTMLInputElement>('[aria-label="query"]')!.focus();

    searchPanel.open = false;
    await settle();

    expect(target.querySelector('[role="dialog"]'), "the panel closed").toBeNull();
    expect(document.activeElement).toBe(origin);
  });

  test("leaves focus where the caller moved it on close", async () => {
    focusOrigin();
    await openSearchShell();
    const opened = document.body.appendChild(document.createElement("button"));
    opened.focus();

    searchPanel.open = false;
    await settle();

    expect(document.activeElement).toBe(opened);
  });
});

test("the overlay has a dialog role and name without claiming modality", async () => {
  const target = await openSearchShell();
  const panel = target.querySelector('[role="dialog"]')!;
  expect(panel.getAttribute("aria-label")).toBe("Search");
  expect(panel.hasAttribute("aria-modal"), "non-modal overlay omits aria-modal").toBe(false);
});
