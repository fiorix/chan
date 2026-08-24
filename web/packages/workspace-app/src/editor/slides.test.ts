import { describe, expect, test } from "vitest";
import {
  firstSlideHeadingCaret,
  groupHeadingsBySlides,
  PAGE_BREAK_RE,
  parseSlidesSpec,
  slideIndexForLine,
  splitSlidePages,
} from "./slides";

type TestHeading = {
  line: number;
  text: string;
};

describe("parseSlidesSpec", () => {
  test("recognizes the slides frontmatter contract", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Title
`;

    expect(parseSlidesSpec(source)).toEqual({ aspectRatio: "16:9", zoomFactor: 2 });
  });

  test("accepts the standard 4:3 aspect ratio", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: '4:3'
---
`;

    expect(parseSlidesSpec(source)).toEqual({ aspectRatio: "4:3", zoomFactor: 2 });
  });

  test("defaults to 16:9 when the aspect ratio is omitted", () => {
    const source = `---
chan:
  kind: slides
  slides:
    zoom_factor: 200%
---
`;

    expect(parseSlidesSpec(source)).toEqual({ aspectRatio: "16:9", zoomFactor: 2 });
  });

  test("accepts a percentage zoom factor", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
    zoom_factor: 200%
---
`;

    expect(parseSlidesSpec(source)).toEqual({ aspectRatio: "16:9", zoomFactor: 2 });
  });

  test("keeps numeric zoom factors compatible with the earlier contract", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
    zoom_factor: 4
---
`;

    expect(parseSlidesSpec(source)).toEqual({ aspectRatio: "16:9", zoomFactor: 4 });
  });

  test("ignores non-slide frontmatter", () => {
    const source = `---
chan:
  kind: contact
---

# Alice
`;

    expect(parseSlidesSpec(source)).toBeNull();
  });

  test("requires a supported aspect ratio", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "1:1"
---
`;

    expect(parseSlidesSpec(source)).toBeNull();
  });
});

describe("groupHeadingsBySlides", () => {
  test("groups headings under slide pages split by page breaks", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1
## Context
<hr class="chan-page-break">
# Slide 2
### Detail
@pagebreak
# Slide 3
`;

    expect(pageHeadingText(source)).toEqual([
      { number: 1, headings: ["Slide 1", "Context"] },
      { number: 2, headings: ["Slide 2", "Detail"] },
      { number: 3, headings: ["Slide 3"] },
    ]);
  });

  test("merges headings into the previous slide when a page break is removed", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1
## Context
# Slide 2
### Detail
<hr class="chan-page-break">
# Slide 3
`;

    expect(pageHeadingText(source)).toEqual([
      { number: 1, headings: ["Slide 1", "Context", "Slide 2", "Detail"] },
      { number: 2, headings: ["Slide 3"] },
    ]);
  });
});

describe("splitSlidePages", () => {
  test("splits slide markdown without rendering frontmatter or page breaks", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1

one

<hr class="chan-page-break">

# Slide 2

two

@pagebreak

# Slide 3
`;

    expect(splitSlidePages(source)).toEqual([
      { number: 1, startLine: 6, endLine: 10, markdown: "\n# Slide 1\n\none\n" },
      { number: 2, startLine: 12, endLine: 16, markdown: "\n# Slide 2\n\ntwo\n" },
      { number: 3, startLine: 18, endLine: 20, markdown: "\n# Slide 3\n" },
    ]);
  });

  test("preserves blank lines inside slide boundaries", () => {
    const source = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---


# Lower title



body


<hr class="chan-page-break">

# Next
`;

    expect(splitSlidePages(source)[0]?.markdown).toBe(
      "\n\n# Lower title\n\n\n\nbody\n\n",
    );
  });

  test("finds the current slide from the caret line", () => {
    const pages = splitSlidePages(`# Slide 1
text
<hr class="chan-page-break">
# Slide 2
text
<hr class="chan-page-break">
# Slide 3
`);

    expect(slideIndexForLine(pages, 0)).toBe(0);
    expect(slideIndexForLine(pages, 2)).toBe(0);
    expect(slideIndexForLine(pages, 3)).toBe(1);
    expect(slideIndexForLine(pages, 6)).toBe(2);
    expect(slideIndexForLine(pages, null)).toBe(0);
  });
});

describe("firstSlideHeadingCaret", () => {
  // Mirrors chan-server's NEW_SLIDES_CONTENT seed (routes/drafts.rs) so
  // the New slide deck caret landing is pinned against the real payload.
  const seed = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# Slide 1
* use \`@pagebreak\` on empty line to create new slide
`;

  test("lands at the end of the seed's # Slide 1 heading line", () => {
    const at = firstSlideHeadingCaret(seed);
    expect(at).toBe(seed.indexOf("# Slide 1") + "# Slide 1".length);
    // The offset sits past the closing frontmatter fence, never inside
    // the metadata block.
    expect(at).toBeGreaterThan(seed.indexOf("\n---\n") + "\n---\n".length);
    expect(seed.slice(at! - "# Slide 1".length, at!)).toBe("# Slide 1");
  });

  test("keeps the seed in slides mode without creating a page break", () => {
    expect(parseSlidesSpec(seed)).toEqual({
      aspectRatio: "16:9",
      zoomFactor: 2,
    });
    const pageBreakLines = seed
      .split(/\r?\n/)
      .filter((line) => PAGE_BREAK_RE.test(line));
    expect(pageBreakLines).toEqual([]);
    expect(splitSlidePages(`${seed}@pagebreak\n# Slide 2\n`)).toHaveLength(
      2,
    );
    expect(splitSlidePages(seed)).toEqual([
      {
        number: 1,
        startLine: 6,
        endLine: 9,
        markdown:
          "\n# Slide 1\n* use `@pagebreak` on empty line to create new slide\n",
      },
    ]);
  });

  test("CRLF sources resolve to the heading end before the \\r", () => {
    const crlf = seed.replaceAll("\n", "\r\n");
    const at = firstSlideHeadingCaret(crlf);
    expect(at).not.toBeNull();
    expect(crlf.slice(at! - "# Slide 1".length, at!)).toBe("# Slide 1");
    expect(crlf[at!]).toBe("\r");
  });

  test("skips #-looking lines inside the frontmatter block", () => {
    const source = `---
chan:
  kind: slides
# a yaml comment, not a heading
---

# Real title
`;
    const at = firstSlideHeadingCaret(source);
    expect(source.slice(at! - "# Real title".length, at!)).toBe("# Real title");
  });

  test("documents without frontmatter land at their first heading", () => {
    expect(firstSlideHeadingCaret("# Draft\nbody\n")).toBe("# Draft".length);
  });

  test("returns null when no heading follows the frontmatter", () => {
    expect(
      firstSlideHeadingCaret("---\nchan:\n  kind: slides\n---\n\nno heading\n"),
    ).toBeNull();
    expect(firstSlideHeadingCaret("#nospace is not a heading\n")).toBeNull();
    expect(firstSlideHeadingCaret("")).toBeNull();
  });
});

function pageHeadingText(source: string): Array<{ number: number; headings: string[] }> {
  return groupHeadingsBySlides(source, testHeadings(source)).map((page) => ({
    number: page.number,
    headings: page.headings.map((heading) => heading.text),
  }));
}

function testHeadings(source: string): TestHeading[] {
  const out: TestHeading[] = [];

  source.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) out.push({ line: index, text: match[2]!.trim() });
  });

  return out;
}
