# A hash at the start of a list item or a quote styles the line as a heading

Status: raised and accepted for v0.120.0 by the owner on 2026-10-31, during the v0.119.0 cut ("one more bug to file"); cause read and probed, not started.

## What was asked

The owner's words, 2026-10-31: "in the rich prompt and possibly / probably in the editor: when the first character of a list is '#' it is treated as a title, but it shouldn't because it's in a list; i think the same should be true for quotes, and codeblock, if not already". The owner's screenshot shows a numbered list in the Rich Prompt whose items start with tags (`#275 follow your recommendation`), and a fourth item where only `#` is typed so far: the whole line renders at heading size while the tag picker opens ("No tags").

## What is there now

Read at `e721c63bf`, the v0.119.0 GA commit. The editor styles a heading from the syntax tree, not from a pattern on the line: `editor/decorations/headings.ts` puts a `cm-md-h1`...`cm-md-h6` line class on every `ATXHeading1`...`ATXHeading6` node the Lezer Markdown parser produces and hides its `#` marks off the caret's line. The Rich Prompt (`components/RichPrompt.svelte`) is the same `Wysiwyg` editor, so both behave alike.

The parser follows CommonMark, where a list item or a block quote may hold a heading. Parsed with `@lezer/markdown` and GFM:

| Line | Parsed as |
| --- | --- |
| `4. #` | list item, heading (empty) |
| `4. #275` | list item, paragraph |
| `1. # foo` and `- # foo` | list item, heading |
| `- #tag` | list item, paragraph |
| `> # foo` and `> #` | block quote, heading |
| a fenced or an indented code block holding `# foo` | code, no heading |
| `#` alone | heading (empty) |
| `#foo` | paragraph |

So a tag typed at the start of a list item makes the line an empty heading for the moment between `#` and its first letter, which is what the screenshot caught; the same flash happens for a tag typed at the start of any line. `# foo` inside a list item or a quote is a heading by CommonMark and on GitHub. Code blocks already never hold a heading.

## Desired contract

1. In the editor and the Rich Prompt, a line inside a list item or a block quote is never styled as a heading, whatever its `#` marks: `4. #`, `- # foo` and `> # foo` keep the size and weight of their list or quote text, and their `#` marks stay visible.
2. An empty heading, a `#` run with nothing after it, is not styled as a heading anywhere, so typing a tag at the start of any line does not flash the line to heading size.
3. Code blocks are unchanged: their content is never a heading.

## Open decisions

- CommonMark and GitHub render `- # foo` and `> # foo` as headings. The owner's rule makes the editor show them as text; whether chan's other Markdown renderings (copy as HTML in `editor/copy_html.ts`, the slide view in `editor/slide_dom.ts`) follow the editor or keep CommonMark. The lead's recommendation: the editor and the Rich Prompt follow the owner's rule, and the renderings that produce HTML for other programs keep CommonMark, so a pasted document reads the same in them.
- Whether the Rich Prompt's outgoing text changes at all: it should not; the rule is about how a line is shown, and the text sent is what was typed.

## Acceptance

1. Decoration tests pin no heading line class on `4. #`, `1. # foo`, `- # foo`, `> # foo` and `> #`, and on `#` alone; a heading class on `# foo` at the top level; and no heading in fenced or indented code. The new cases are red before the fix.
2. In the Rich Prompt, typing `4. #275` in a numbered list keeps the line at list size throughout, and the tag picker still opens on `#`.
