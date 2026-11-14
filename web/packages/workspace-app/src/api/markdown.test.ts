// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { renderMarkdown, renderMarkdownWithBreaks } from "./markdown";

describe("wikilink labels", () => {
  test.each([
    ["[[note]]", "note"],
    ["[[note|alias]]", "alias"],
    ["[[folder/note.md]]", "note"],
    ["[[/folder/note.md#heading]]", "note"],
    ["[[folder/note.md^block]]", "note"],
    ["[[folder/note.md#heading| alias ]]", "alias"],
    ["[[note|]]", ""],
    ["[[folder/My Note.md]]", "My Note"],
    ["[[note]] and [[other|alias]]", "note and alias"],
    ["[[outer [[note]] tail]]", "[[outer note tail]]"],
  ])("renders %s as the editor label", (source, label) => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(source);
    expect(root.querySelector("p")?.textContent).toBe(label);
  });

  test("keeps labels literal, including markup, entities and Markdown", () => {
    const label = '<em>alias</em> &amp; **bold** <img src=x onerror="alert(1)">';
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(`[[note|${label}]]`);
    expect(root.querySelector("p")?.textContent).toBe(label);
    expect(root.querySelector("em, strong, img")).toBeNull();
  });

  test("recognizes labels inside normal Markdown without changing its markup", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      "# Before [[note]] after\n\n- **[[note|alias]]** [web](https://example.com)\n",
    );
    expect(root.querySelector("h1")?.textContent).toBe("Before note after");
    expect(root.querySelector("li strong")?.textContent).toBe("alias");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  test("leaves inline code and fenced code as typed", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
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
      root.innerHTML = renderMarkdown(source);
      expect(root.querySelector("p")?.textContent).toBe(source.replace("\\", ""));
    },
  );

  test("keeps the sanitizing boundary for surrounding Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
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
