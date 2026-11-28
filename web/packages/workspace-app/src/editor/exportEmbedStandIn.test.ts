// @vitest-environment jsdom
//
// An export cannot paint an iframe and the snapshot audit refuses one, so
// both compositions replace an embed with a printable stand-in. An embed
// reaches a document two ways: the image syntax the renderer turns into an
// iframe, and a raw `<iframe>` the author pastes, which the sanitizer
// admits whenever its src is on the embed host allowlist. Both have to be
// replaced, and the live preview has to keep its playable frame.

import { afterEach, describe, expect, test } from "vitest";
import { buildDocDom } from "./doc_dom";
import { buildSlidePageDom } from "./pdf_pages";
import { prepareSlideImages } from "./slide_dom";
import { auditSelfContained } from "./pdf_snapshot";

const MAP_SRC = "https://www.google.com/maps/embed?pb=!1m18!1m12";
const RAW_EMBED = `<iframe src="${MAP_SRC}" title="Office"></iframe>`;
const IMAGE_EMBED = "![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)";

const hosts: HTMLElement[] = [];

/// The audit runs on an attached element in the real export, and refuses
/// an iframe by name.
function attach(el: HTMLElement): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(el);
  document.body.appendChild(host);
  hosts.push(host);
  return el;
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  document.body.innerHTML = "";
});

describe("a pasted iframe the sanitizer admits", () => {
  test("the document composition stands in for it", () => {
    const dom = buildDocDom({
      markdown: `before\n\n${RAW_EMBED}\n\nafter`,
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 800,
    });
    attach(dom.root);
    expect(() => auditSelfContained(dom.content)).not.toThrow();
  });

  test("the deck composition stands in for it", () => {
    const page = buildSlidePageDom({
      markdown: `# Slide\n\n${RAW_EMBED}`,
      fromPath: "decks/d.md",
      spec: { aspectRatio: "16:9", zoomFactor: 2 },
      theme: "light",
    });
    attach(page.root);
    expect(() => auditSelfContained(page.root)).not.toThrow();
  });

  test("the stand-in names the embed and carries its address", () => {
    const dom = buildDocDom({
      markdown: `before\n\n${RAW_EMBED}\n\nafter`,
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 800,
    });
    const link = attach(dom.root).querySelector("a");
    expect(link?.getAttribute("href")).toBe(MAP_SRC);
    // A page is a raster, so the href is neither visible nor clickable:
    // whatever a reader can act on has to be in the text.
    expect(link?.textContent).toContain("Office");
    expect(link?.textContent).toContain(MAP_SRC);
  });
});

describe("the image-syntax embed", () => {
  test("the document composition still stands in for it", () => {
    const dom = buildDocDom({
      markdown: `before\n\n${IMAGE_EMBED}\n\nafter`,
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 800,
    });
    attach(dom.root);
    expect(() => auditSelfContained(dom.content)).not.toThrow();
  });
});

// A YouTube frame's src carries the player API's parameter, which the
// screen lock needs and a reader does not, so the printed address is the
// embed's own: the stand-in leaves that parameter out and keeps the rest.
describe("a YouTube embed's printed address", () => {
  const ADDRESS = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

  function printedInDocument(markdown: string): Element | null {
    const dom = buildDocDom({
      markdown: `before\n\n${markdown}\n\nafter`,
      path: "notes/doc.md",
      theme: "light",
      contentWidthPx: 800,
    });
    return attach(dom.root).querySelector("a");
  }

  test("the document prints the image syntax's embed at its address", () => {
    const link = printedInDocument(IMAGE_EMBED);
    expect(link?.textContent).toBe(`YouTube video: ${ADDRESS}`);
    expect(link?.getAttribute("href")).toBe(ADDRESS);
  });

  test("the deck prints it at its address", () => {
    const page = buildSlidePageDom({
      markdown: `# Slide\n\n${IMAGE_EMBED}`,
      fromPath: "decks/d.md",
      spec: { aspectRatio: "16:9", zoomFactor: 2 },
      theme: "light",
    });
    const link = attach(page.root).querySelector("a");
    expect(link?.textContent).toBe(`YouTube video: ${ADDRESS}`);
    expect(link?.getAttribute("href")).toBe(ADDRESS);
  });

  test("a pasted frame keeps the parameters its author wrote", () => {
    const src = `${ADDRESS}?list=PLa,PLb&start=30#t`;
    const link = printedInDocument(`<iframe src="${src}" title="Talk"></iframe>`);
    expect(link?.textContent).toBe(`Talk: ${src}`);
    expect(link?.getAttribute("href")).toBe(src);
  });

  test("a map frame's address is printed as written", () => {
    const src = `${MAP_SRC}&enablejsapi=1`;
    const link = printedInDocument(`<iframe src="${src}" title="Office"></iframe>`);
    expect(link?.textContent).toBe(`Office: ${src}`);
  });
});

describe("the live preview", () => {
  test("keeps the embed it can play", async () => {
    const root = document.createElement("div");
    root.innerHTML = RAW_EMBED;
    attach(root);
    await prepareSlideImages(root, "notes/doc.md", "light", () => true);
    expect(root.querySelector("iframe")).not.toBeNull();
  });
});
