// @vitest-environment jsdom
//
// The export waits for every image to settle before it measures. One
// image that never settles must not spend the whole page timeout, which
// names nothing: the composition gives up on it and hands it to the
// inline pass and the audit, which name it by src. A lazy image is the
// case that never settles on its own, because an export composition is
// never in a viewport.

import { afterEach, describe, expect, test, vi } from "vitest";
import { buildDocDom } from "./doc_dom";

const hosts: HTMLElement[] = [];

function compose(markdown: string): ReturnType<typeof buildDocDom> {
  const dom = buildDocDom({
    markdown,
    path: "notes/doc.md",
    theme: "light",
    contentWidthPx: 800,
  });
  const host = document.createElement("div");
  host.appendChild(dom.root);
  document.body.appendChild(host);
  hosts.push(host);
  return dom;
}

/// Did the promise settle by the time the loop has drained?
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

afterEach(() => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.remove();
  document.body.innerHTML = "";
});

describe("an image the composition can never see settle", () => {
  test("a lazy image is made eager, so its load can arrive at all", () => {
    const dom = compose('before\n\n<img src="pic.png" loading="lazy">\n\nafter');
    const img = dom.content.querySelector("img");
    expect(img?.getAttribute("loading")).toBe("eager");
  });

  test("one silent image does not hold the export open", async () => {
    vi.useFakeTimers();
    const dom = compose('before\n\n<img src="pic.png">\n\nafter');
    expect(await settled(dom.completion)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled(dom.completion)).toBe(true);
  });

  test("an image that loads settles the composition without waiting", async () => {
    vi.useFakeTimers();
    const dom = compose('before\n\n<img src="pic.png">\n\nafter');
    for (const img of Array.from(dom.content.querySelectorAll("img"))) {
      img.dispatchEvent(new Event("load"));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled(dom.completion)).toBe(true);
  });
});
