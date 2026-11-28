// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { renderMarkdown, renderMarkdownInline, renderMarkdownWithBreaks } from "./markdown";

function renderMarkdownForExport(input: string): string {
  return renderMarkdown(input, { wikilinks: true });
}

describe("wikilink labels", () => {
  test("renders wikilink labels in every renderer that opts in", () => {
    const source = "[[note]] [[note|alias]]";
    for (const html of [renderMarkdown(source, { wikilinks: true }), renderMarkdownWithBreaks(source, { wikilinks: true }), renderMarkdownInline(source, { wikilinks: true })]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.textContent?.trim()).toBe("note alias");
    }
  });

  test("leaves inline code and fenced code as typed in every renderer that opts in", () => {
    const source = "`[[note]]`\n\n```text\n[[note]]\n```\n";
    for (const html of [renderMarkdown(source, { wikilinks: true }), renderMarkdownWithBreaks(source, { wikilinks: true })]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.querySelector("p code")?.textContent).toBe("[[note]]");
      expect(root.querySelector("pre code")?.textContent).toBe("[[note]]\n");
    }
    const inline = document.createElement("div");
    inline.innerHTML = renderMarkdownInline("`[[note]]`", { wikilinks: true });
    expect(inline.querySelector("code")?.textContent).toBe("[[note]]");
  });

  test("a call without the option keeps the authored syntax in every renderer", () => {
    const source = "[[note]] [[note|alias]]";
    for (const html of [renderMarkdown(source), renderMarkdownWithBreaks(source), renderMarkdownInline(source)]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.textContent?.trim()).toBe(source);
    }
  });

  test("keeps a markup-carrying label literal and element-free in every renderer that opts in", () => {
    const label = '<img src=x onerror="alert(1)">';
    for (const html of [renderMarkdown(`[[note|${label}]]`, { wikilinks: true }), renderMarkdownWithBreaks(`[[note|${label}]]`, { wikilinks: true }), renderMarkdownInline(`[[note|${label}]]`, { wikilinks: true })]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.querySelector("img")).toBeNull();
      expect(root.textContent).toContain(label);
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

// Strict labels serve prose with no note behind it, a survey body, where
// double brackets are as likely a shell test as a link.
describe("strict wikilink labels", () => {
  function strict(source: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdownWithBreaks(source, { wikilinks: "strict" });
    return root;
  }

  test.each([
    ["Open [[note]] now", "Open note now"],
    ["Open [[note|alias]] now", "Open alias now"],
    ["Open [[folder/note.md#heading]] now", "Open note now"],
    ["Open [[My Note]] now", "Open My Note now"],
    ["Open [[note ]] now", "Open note now"],
  ])("labels a plain link: %s", (source, label) => {
    expect(strict(source).textContent?.trim()).toBe(label);
  });

  test.each([
    "Should I replace [[ -f a/b.txt ]] with [ -f a/b.txt ]?",
    'if [[ "$a" == "$b" || -z "$c" ]]; then',
    "Use [[ $x =~ ^v#1 ]] here",
    "Padded [[ note ]] here",
    "Run [[\t-f a ]] now",
  ])("leaves a body that opens with whitespace as typed: %s", (source) => {
    expect(strict(source).textContent?.trim()).toBe(source);
  });

  test.each([
    "Matrix [[1, 2], [3, 4]] here",
    "Open [[note|a [b] c]] now",
    "Open [[a] b]] now",
    "Open [[a [b]] now",
  ])("leaves a body that holds a bracket as typed: %s", (source) => {
    expect(strict(source).textContent?.trim()).toBe(source);
  });

  test.each([
    "Strip it with sed 's/[[:space:]]*$//' first?",
    "grep -E '^[[:space:]]*#' conf",
    "Match [[:alpha:]] here",
  ])("leaves a POSIX class as typed: %s", (source) => {
    expect(strict(source).textContent?.trim()).toBe(source);
  });

  test.each([
    "Use [[ $x =~ ^[[:digit:]]+$ ]] here",
    "nested [[ $x == [[note]] ]] end",
    "if [[ $a == [[x]] && $b == [[y]] ]]; then",
  ])("leaves a link inside a shell test as typed: %s", (source) => {
    expect(strict(source).textContent?.trim()).toBe(source);
  });

  test.each([
    ["if [[ -f a ]]; then open [[note]]", "if [[ -f a ]]; then open note"],
    ["Open [[note]] or run [[ -f a ]]", "Open note or run [[ -f a ]]"],
    ["Padded [[ my note]] and [[note]] here", "Padded [[ my note]] and note here"],
    ["Open [[Re: note]] now", "Open Re: note now"],
  ])("labels a plain link beside a shell test or with a colon: %s", (source, label) => {
    expect(strict(source).textContent?.trim()).toBe(label);
  });

  test("labels a plain link beside bracket text it leaves as typed", () => {
    expect(strict("Run [[ -f a.txt ]] and [[1], [2]], then open [[note|alias]]").textContent?.trim())
      .toBe("Run [[ -f a.txt ]] and [[1], [2]], then open alias");
  });

  test("leaves inline code and fenced code as typed", () => {
    const root = strict("Type `[[note]]` here\n\n```text\n[[note]]\n```\n");
    expect(root.querySelector("p code")?.textContent).toBe("[[note]]");
    expect(root.querySelector("pre code")?.textContent).toBe("[[note]]\n");
  });

  test("keeps a markup-carrying label literal and element-free", () => {
    const label = '<img src=x onerror="alert(1)">';
    const root = strict(`Open [[note|${label}]] now`);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent?.trim()).toBe(`Open ${label} now`);
  });

  test("the other label passes keep the editor's reading of a padded link and a bracket in an alias", () => {
    const source = "[[ note ]] and [[note|a [b] c]]";
    for (const html of [renderMarkdown(source, { wikilinks: true }), renderMarkdownWithBreaks(source, { wikilinks: true }), renderMarkdownInline(source, { wikilinks: true })]) {
      const root = document.createElement("div");
      root.innerHTML = html;
      expect(root.textContent?.trim()).toBe("note and a [b] c");
    }
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
