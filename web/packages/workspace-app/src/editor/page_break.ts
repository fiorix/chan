// The one definition of a page break, in source and in the rendered
// document. Deck splitting, the source editor's divider, document
// pagination, deck export and the printable stylesheet all ask this
// module, so a line is a page break on every surface or on none.
//
// A page break is an `hr` whose only attribute is a `class` of exactly
// `chan-page-break`. Quote style, whitespace inside the tag and the
// self-closing slash are spelling HTML does not distinguish, so
// `<hr class='chan-page-break'/>` is the same element. An extra class, a
// different case in the class value, or any other attribute makes a
// different element, and that element is an ordinary horizontal rule.
// chan never rewrites a line the author wrote, so a near miss stays as
// written and cuts nothing.
//
// `@pagebreak` is a typing macro that writes the marker (commands/
// page_break.ts); a line left literally in a file is text.

/// The class the marker carries, compared verbatim: HTML class values
/// are case-sensitive even though tag and attribute names are not.
export const PAGE_BREAK_CLASS = "chan-page-break";

/// What chan writes when it writes a page break.
export const PAGE_BREAK_MARKER = `<hr class="${PAGE_BREAK_CLASS}">`;

/// The attribute a rendered document carries on its page breaks, and the
/// selector the printable stylesheet uses. CSS cannot ask whether an
/// element has no OTHER attribute, so the element test runs once, in
/// `markPageBreaks`, and the DOM carries its answer.
export const PAGE_BREAK_ATTR = "data-page-break";
export const PAGE_BREAK_SELECTOR = `hr[${PAGE_BREAK_ATTR}]`;

const MARKER_LINE_RE = /^\s*<hr\s+class\s*=\s*(["'])([^"']*)\1\s*\/?>\s*$/i;

/// Is this source line, on its own, the page-break marker? Line context
/// is `pageBreakLineFlags`'s job: a marker inside a fenced code block is
/// still a marker line, and still not a page break.
export function isPageBreakMarkerLine(text: string): boolean {
  return MARKER_LINE_RE.exec(text)?.[2] === PAGE_BREAK_CLASS;
}

/// Is this rendered element a page break?
export function isPageBreakElement(el: Element): boolean {
  if (el.tagName !== "HR") return false;
  if (el.getAttribute("class") !== PAGE_BREAK_CLASS) return false;
  // The marker carries its class and nothing else. chan's own mark is
  // not an authored attribute, so a second pass over a marked document
  // reaches the same answer as the first.
  return Array.from(el.attributes).every(
    (attr) => attr.name === "class" || attr.name === PAGE_BREAK_ATTR,
  );
}

/// Mark the page breaks of a rendered document so the stylesheet and the
/// block measurement read one answer rather than each repeating the test.
export function markPageBreaks(content: Element): void {
  for (const hr of content.querySelectorAll("hr")) {
    if (isPageBreakElement(hr)) hr.setAttribute(PAGE_BREAK_ATTR, "");
  }
}

/// Which lines of a source document are page breaks, by line index.
///
/// A fenced code block is source the author is showing rather than
/// writing, so a marker inside one is a code sample and cuts nothing.
/// Fences are stateful, which is why this answers for a whole document
/// and no surface asks about a line on its own.
export function pageBreakLineFlags(lines: readonly string[]): boolean[] {
  const flags: boolean[] = [];
  let fence = "";
  for (const line of lines) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter !== undefined) {
      if (fence === "") {
        fence = delimiter;
      } else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) {
        fence = "";
      }
      flags.push(false);
      continue;
    }
    flags.push(fence === "" && isPageBreakMarkerLine(line));
  }
  return flags;
}
