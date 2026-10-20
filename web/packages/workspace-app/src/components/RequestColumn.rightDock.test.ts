// @vitest-environment jsdom
//
// The request column sits at the workspace's right edge, as the status bar
// does: at the window edge with no right dock, or beside the right-docked
// Files browser, following its live width as the dock resizes.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { browserSidePanes, paneWidths } from "../state/store.svelte";
import RequestColumn from "./RequestColumn.svelte";

let view: Record<string, unknown> | null = null;
const width = paneWidths.browser;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  browserSidePanes.right = false;
  paneWidths.browser = width;
});

function column(): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(RequestColumn, { target });
  flushSync();
  return target.querySelector<HTMLElement>(".request-corner")!;
}

describe("the request column's right edge", () => {
  test("sits at the window edge with no right dock", () => {
    expect(column().style.getPropertyValue("--right-dock")).toBe("0px");
  });

  test("sits beside the right dock and follows its width", () => {
    browserSidePanes.right = true;
    paneWidths.browser = 300;
    const el = column();
    expect(el.style.getPropertyValue("--right-dock")).toBe("300px");

    paneWidths.browser = 420;
    flushSync();
    expect(el.style.getPropertyValue("--right-dock")).toBe("420px");
  });
});
