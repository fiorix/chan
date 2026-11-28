// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { renderMarkdown, renderMarkdownInline, renderMarkdownWithBreaks } from "./markdown";

function renderMarkdownForExport(input: string): string {
  return renderMarkdown(input, { wikilinks: true });
}

describe("wikilink labels", () => {
  test("requires an explicit export option and leaves sibling renderers alone", () => {
    const source = "[[note]] [[note|alias]]";
    for (const html of [renderMarkdown(source), renderMarkdownWithBreaks(source), renderMarkdownInline(source)]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.textContent?.trim()).toBe(source);
    }
  });

  test.each([
    ["**a [[note|b** c]] d**", "strong", "a b** c d"],
    ["*a [[note|b* c]] d*", "em", "a b* c d"],
    ["__a [[note|b__ c]] d__", "strong", "a b__ c d"],
    ["***a [[note|b*** c]] d***", "strong", "a b*** c d"],
  ])("keeps alias delimiters literal inside emphasis: %s", (source, tag, expected) => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(source);
    expect(root.querySelector(tag)?.textContent).toBe(expected);
    expect(root.textContent).not.toContain("[[");
  });

  test.each([
    "**a www.example.com/[[note|b** c]] d**",
    "**a [[outer `[[inner]]`|b** c]] d**",
    '**a [[outer <span title="[[inner]]">|b** c]] d**',
    "![photo [[note|alias]]](pic.png)",
  ])("preserves Markdown where the editor recognizes no wikilink: %s", (source) => {
    expect(renderMarkdownForExport(source)).toBe(renderMarkdown(source));
  });

  test.each([
    ["[[note]]", "note"],
    ["[[note|alias]]", "alias"],
    ["[[folder/note.md]]", "note"],
    ["[[/folder/note.md#heading]]", "note"],
    ["[[folder/note.md^block]]", "note"],
    ["[[folder/note.md#heading| alias ]]", "alias"],
    ["[[note|]]", ""],
    ["[[folder/My Note.md]]", "My Note"],
    ["[[note|cafe\u0301 \u{1f680}]]", "cafe\u0301 \u{1f680}"],
    ["[[note]] and [[other|alias]]", "note and alias"],
    ["[[outer [[note]] tail]]", "[[outer note tail]]"],
  ])("renders %s as the editor label", (source, label) => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(source);
    expect(root.querySelector("p")?.textContent).toBe(label);
  });

  test("keeps an empty alias's inline boundary beside emphasis", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport("a[[note|]]_bold_");
    expect(root.querySelector("em")?.textContent).toBe("bold");
    expect(root.querySelector("p")?.textContent).toBe("abold");
  });

  test("keeps labels literal, including markup, entities and Markdown", () => {
    const label = '<em>alias</em> &amp; **bold** <img src=x onerror="alert(1)" data-page-break="true">';
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(`[[note|${label}]]`);
    expect(root.querySelector("p")?.textContent).toBe(label);
    expect(root.querySelector("em, strong, img, [data-page-break]")).toBeNull();
  });

  test("recognizes labels inside normal Markdown without changing its markup", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(
      "# Before [[note]] after\n\n- **[[note|alias]]** [web](https://example.com)\n",
    );
    expect(root.querySelector("h1")?.textContent).toBe("Before note after");
    expect(root.querySelector("li strong")?.textContent).toBe("alias");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  test("leaves inline code and fenced code as typed", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(
      "`[[note]]` and `[[note|alias]]`\n\n```text\n[[note]] [[note|alias]]\n```\n",
    );
    expect(Array.from(root.querySelectorAll("p code"), (el) => el.textContent))
      .toEqual(["[[note]]", "[[note|alias]]"]);
    expect(root.querySelector("pre code")?.textContent).toBe("[[note]] [[note|alias]]\n");
  });

  test.each(["[[]]", "[[first\nsecond]]", "\\[[note]]"])(
    "leaves non-wikilink syntax %s as text",
    (source) => {
      const root = document.createElement("div");
      root.innerHTML = renderMarkdownForExport(source);
      expect(root.querySelector("p")?.textContent).toBe(source.replace("\\", ""));
    },
  );

  test("keeps the sanitizing boundary for surrounding Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownForExport(
      '[[note|alias]] <img src="x" onerror="alert(1)"><script>alert(2)</script>',
    );
    expect(root.querySelector("p")?.textContent).toBe("alias ");
    expect(root.querySelector("script, [onerror]")).toBeNull();
  });
});

describe("survey body line breaks", () => {
  test("renderMarkdown collapses a single newline (global breaks:false soft-break)", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).not.toContain("<br");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
  });

  test("renderMarkdownWithBreaks renders a single newline as a <br>", () => {
    const html = renderMarkdownWithBreaks("line one\nline two");
    expect(html).toContain("<br");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
  });

  test("renderMarkdownWithBreaks still separates paragraphs on a blank line", () => {
    const html = renderMarkdownWithBreaks("para one\n\npara two");
    // Two distinct paragraphs, not one with a <br>.
    expect(html.match(/<p>/g)?.length).toBe(2);
  });

  test("renderMarkdownWithBreaks is DOMPurify-sanitized", () => {
    const html = renderMarkdownWithBreaks("hi <script>alert(1)</script>");
    expect(html).not.toContain("<script");
  });
});

describe("markdown iframe embeds", () => {
  test("a YouTube image link renders a youtube-nocookie iframe", () => {
    const html = renderMarkdown("![](https://youtu.be/dQw4w9WgXcQ)");
    expect(html).toContain("<iframe");
    expect(html).toContain(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(html).toContain("sandbox");
  });

  test("a Google Maps image link renders a maps iframe", () => {
    const html = renderMarkdown(
      "![](https://www.google.com/maps/embed?pb=!1m18!1m12)",
    );
    expect(html).toContain("<iframe");
    expect(html).toContain("https://www.google.com/maps/embed?pb=");
  });

  test("a plain image stays an <img>, not an iframe", () => {
    const html = renderMarkdown("![cat](https://example.com/cat.png)");
    expect(html).toContain("<img");
    expect(html).not.toContain("<iframe");
  });

  test("a raw <iframe> on a non-allowlisted host is dropped", () => {
    const html = renderMarkdown('<iframe src="https://evil.com/x"></iframe>');
    expect(html).not.toContain("evil.com");
    expect(html).not.toContain("<iframe");
  });
});

describe("the player API on a YouTube embed frame", () => {
  // The screen lock pauses a YouTube embed by posting its player a command,
  // which the player reads only when the frame's src carries enablejsapi=1.
  const EMBED = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  const DEFAULT_SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups";

  function frame(source: string): HTMLIFrameElement | null {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(source);
    return template.content.querySelector("iframe");
  }

  test.each([
    ["with the default sandbox", "", DEFAULT_SANDBOX],
    ["with a sandbox of its own", ' sandbox="allow-scripts allow-same-origin"', "allow-scripts allow-same-origin"],
  ])("a raw YouTube frame %s gains the parameter, keeping the rest as written", (_, sandboxAttr, sandbox) => {
    const query = "autoplay=1&mute=1&loop=1&playlist=dQw4w9WgXcQ,M7lc1UVf-VE";
    const el = frame(`<iframe src="${EMBED}?${query}#t=30" allow="autoplay; encrypted-media"${sandboxAttr}></iframe>`);
    expect(el?.getAttribute("src")).toBe(`${EMBED}?${query}&enablejsapi=1#t=30`);
    expect(el?.getAttribute("allow")).toBe("autoplay; encrypted-media");
    expect(el?.getAttribute("sandbox")).toBe(sandbox);
  });

  test.each(["enablejsapi=1", "enablejsapi=0"])("a raw YouTube frame whose src sets %s is left as written", (param) => {
    const src = `${EMBED}?${param}&autoplay=1`;
    expect(frame(`<iframe src="${src}"></iframe>`)?.getAttribute("src")).toBe(src);
  });

  test("the image syntax's YouTube frame carries the parameter once", () => {
    expect(frame("![](https://youtu.be/dQw4w9WgXcQ)")?.getAttribute("src")).toBe(`${EMBED}?enablejsapi=1`);
  });

  test("a map frame's src is left as written", () => {
    const src = "https://www.google.com/maps/embed?pb=!1m18!1m12";
    expect(frame(`<iframe src="${src}"></iframe>`)?.getAttribute("src")).toBe(src);
  });

  test("a YouTube frame whose src does not parse is still dropped", () => {
    expect(frame('<iframe src="https://www.youtube-nocookie.com:99999/embed/dQw4w9WgXcQ"></iframe>')).toBeNull();
  });
});

describe("style elements", () => {
  // The renderers' HTML enters the app's own document, where a `<style>`
  // element's rules reach every element, so none of them keeps one unless
  // asked to.
  const RULE = "#outside-the-render{visibility:hidden}";
  const RENDERERS: Array<[string, (source: string) => string]> = [
    ["renderMarkdown", (source) => renderMarkdown(source)],
    ["renderMarkdown with wikilink labels", (source) => renderMarkdown(source, { wikilinks: true })],
    ["renderMarkdownWithBreaks", renderMarkdownWithBreaks],
    ["renderMarkdownInline", renderMarkdownInline],
  ];
  const SPELLINGS: Array<[string, string]> = [
    ["after other content", `Text first.\n\n<style>${RULE}</style>\n\nafter`],
    ["after text on its line", `Text first <style>${RULE}</style> after`],
    ["inside an inline svg after other content", `Text first <svg><style>${RULE}</style></svg> after`],
    ["inside an inline svg leading the body", `<svg><style>${RULE}</style></svg> after`],
    ["after a hard line break leading the body", `  \n<style>${RULE}</style>\n\nafter`],
    ["leading the body", `<style>${RULE}</style>\n\nafter`],
  ];

  function parsed(html: string): DocumentFragment {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  describe.each(RENDERERS)("%s", (_, render) => {
    test.each(SPELLINGS)("drops a style element %s, with its rules", (_, source) => {
      const html = parsed(render(source));
      expect(html.textContent, "the content beside it renders").toContain("after");
      expect.soft(html.querySelector("style"), "no style element").toBeNull();
      expect.soft(html.textContent, "none of its rules as text").not.toContain("visibility");
    });
  });

  test.each(SPELLINGS.slice(0, 3))("renderMarkdown asked to keep style elements keeps one %s", (_, source) => {
    const html = parsed(renderMarkdown(source, { keepStyleElements: true }));
    expect(html.querySelector("style")?.textContent).toBe(RULE);
  });
});
