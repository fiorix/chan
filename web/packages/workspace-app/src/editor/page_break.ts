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

/// The attribute a composed document carries on its page breaks, and the
/// selector the printable stylesheet uses. CSS can ask neither whether an
/// element has no OTHER attribute nor whether it is a top-level block, so
/// `markPageBreaks` decides both once and the DOM carries its answer;
/// every reader of a composed document asks for this attribute and
/// applies no test of its own.
export const PAGE_BREAK_ATTR = "data-page-break";
export const PAGE_BREAK_SELECTOR = `hr[${PAGE_BREAK_ATTR}]`;

/// Up to three columns of indentation, because four is a code block and
/// the marker is not code. The class value may be quoted either way or
/// left bare: quoting is spelling HTML does not distinguish. The value
/// itself is compared verbatim, because HTML class values are
/// case-sensitive even though tag and attribute names are not.
const MARKER_LINE_RE =
  /^ {0,3}<hr\s+class\s*=\s*(?:(["'])([^"']*)\1|([^\s"'`=<>]+))\s*\/?>\s*$/i;

/// Is this source line, on its own, the page-break marker? Line context
/// is `pageBreakLineFlags`'s job: a marker inside a fenced code block is
/// still a marker line, and still not a page break.
export function isPageBreakMarkerLine(text: string): boolean {
  const match = MARKER_LINE_RE.exec(text);
  if (!match) return false;
  return (match[2] ?? match[3]) === PAGE_BREAK_CLASS;
}

/// Is this element the marker? The class and nothing else, which is what
/// the marker line parses to. Applied by `markPageBreaks` and by nothing
/// else: a composed document is read through the mark.
function isPageBreakElement(el: Element): boolean {
  return (
    el.tagName === "HR" &&
    el.attributes.length === 1 &&
    el.getAttribute("class") === PAGE_BREAK_CLASS
  );
}

/// Decide the page breaks of a composed document, once, and record the
/// answer on the elements themselves.
///
/// An author can write this attribute: the sanitizer keeps a `data-`
/// attribute as it keeps any other, so a forged one arrives looking like
/// a decision already made. Every mark is cleared, and a forged one is
/// an authored attribute like any other while the test looks, so the
/// element carrying it carries an attribute besides its class, which
/// is what a near miss is, rather than being laundered into a marker
/// by its own removal. That is why
/// the decision is taken before anything is cleared, and why this runs
/// once, on a document that has just been rendered.
///
/// A page break is a TOP-LEVEL block. It cuts the page it ends, and only
/// a direct child of the content is a block the pagination measures, so
/// a marker inside a quote, a list, a table cell or a raw HTML block is
/// an ordinary horizontal rule: inert and unstyled, like every other
/// near miss.
export function markPageBreaks(content: Element): void {
  const breaks = Array.from(content.children).filter(isPageBreakElement);
  for (const forged of Array.from(
    content.querySelectorAll(`[${PAGE_BREAK_ATTR}]`),
  )) {
    forged.removeAttribute(PAGE_BREAK_ATTR);
  }
  for (const el of breaks) el.setAttribute(PAGE_BREAK_ATTR, "");
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
