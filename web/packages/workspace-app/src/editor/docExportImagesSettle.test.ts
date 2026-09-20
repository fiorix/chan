// @vitest-environment jsdom
//
// The document export measures block heights to decide where to cut pages,
// and it measures as soon as the render completion resolves. So what that
// completion waits for decides whether the cuts land where the reader sees
// them: were an ordinary image to contribute nothing, the measurement would
// run while every image was still zero-height. The completion is the
// contract these tests hold: it resolves once the images have settled,
// loaded or failed, and it never waits forever.
//
// The cuts themselves are not asserted here. jsdom reports every element as
// zero-height, so a page cut has no meaning in this environment; what the
// export waits for does.

import { afterEach, describe, expect, test } from "vitest";
import { buildDocDom } from "./doc_dom";
import { auditSelfContained } from "./pdf_snapshot";

const YOUTUBE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let host: HTMLElement | undefined;

/// The printable document container for `markdown`, attached so the
/// widgets and images behave as they do during an export.
function build(markdown: string) {
  const dom = buildDocDom({
    markdown,
    path: "notes/doc.md",
    theme: "light",
    contentWidthPx: 800,
  });
  host = document.createElement("div");
  host.appendChild(dom.root);
  document.body.appendChild(host);
  return dom;
}

/// Whether `completion` resolves while nothing has loaded. The diagram
/// half of the completion settles over a few turns of the event loop even
/// when there is nothing to render, so the probe waits out a generous
/// number of them: what it reports is "resolved without the image", not
/// "resolved this instant".
async function settlesWithoutTheImage(completion: Promise<void>): Promise<boolean> {
  let settled = false;
  void completion.then(() => {
    settled = true;
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return settled;
}

afterEach(() => {
  host?.remove();
  host = undefined;
  document.body.innerHTML = "";
});

describe("the export waits for its images", () => {
  test("an image that has not loaded holds the completion open", async () => {
    const dom = build("# Title\n\n![](a.png)\n\ntail\n");
    expect(dom.content.querySelector("img")).toBeTruthy();
    expect(await settlesWithoutTheImage(dom.completion)).toBe(false);
  });

  test("the completion resolves once the image loads", async () => {
    const dom = build("![](a.png)\n");
    dom.content.querySelector("img")!.dispatchEvent(new Event("load"));
    await expect(dom.completion).resolves.toBeUndefined();
  });

  test("an image that fails does not hang the export", async () => {
    const dom = build("![](a.png)\n");
    dom.content.querySelector("img")!.dispatchEvent(new Event("error"));
    await expect(dom.completion).resolves.toBeUndefined();
  });

  test("a document with no images settles immediately", async () => {
    const dom = build("# Title\n\nbody\n");
    expect(await settlesWithoutTheImage(dom.completion)).toBe(true);
  });
});

describe("an embed in a document that is being exported", () => {
  test("the page carries a link where the embed was", () => {
    const dom = build(`![](${YOUTUBE})\n`);
    expect(dom.content.querySelector("iframe")).toBeNull();
    const link = dom.content.querySelector("a");
    expect(link?.getAttribute("href")).toContain("dQw4w9WgXcQ");
    expect(link?.textContent?.trim()).toBeTruthy();
  });

  test("the self-contained audit passes with the embed on the page", () => {
    const dom = build(`text\n\n![](${YOUTUBE})\n`);
    expect(() => auditSelfContained(dom.content)).not.toThrow();
  });
});
