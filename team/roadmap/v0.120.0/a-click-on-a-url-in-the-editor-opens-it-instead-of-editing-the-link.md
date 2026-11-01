# A click on a URL in the editor opens it instead of editing the link

Status: raised and accepted for v0.120.0 by the owner on 2026-10-31, during the v0.119.0 cut ("one more to file"), with its questions decided by the owner the same day (the section Decisions); not started.

## What was asked

The owner's words, 2026-10-31: "in the editor, when we click on a link to a file, we get this nice widget showing information about it [...] when we click on a url, it should do the same, rather than open the link directly; the main reason is to keep the first click on the link reserved to *editing* the link, rather than opening it.. the link to local files is perfect, once clicked, it opens the dialog but also places the cursor at the end of the text with the link, to edit; this is what i want for urls". The owner's screenshot shows `[CONTRIBUTING.md](CONTRIBUTING.md)` after one click: the link's source revealed, the caret at the end of the target, and the link picker open with an `OPEN CONTRIBUTING.md` row, a matching file, and the hint for Enter to insert and Cmd+Enter to open.

## What is there now

Read at `e721c63bf`, the v0.119.0 GA commit:

- `editor/external_links.ts` installs a click handler in the editor (`externalLinkClickHandler`, wired in `Wysiwyg.svelte`). A plain click on a rendered link (`.cm-md-link`, `.cm-md-link-url`) whose URL has an openable scheme (`http`, `https`, `mailto`, `tel`) prevents the click's default, stops it and opens the URL with the desktop opener at once; a `chan://graph` link opens its graph tab the same way. The caret never moves into the link, so the link cannot be edited by clicking it.
- A link to a file takes no such handler: the click moves the caret into the link, which reveals its source, and the link picker (`editor/bubbles/wiki.ts`) opens on the target slot. In the raw `[label](target)` slot mode the picker shows an `OPEN <target>` row when the slot resolves to a workspace file (`selfHit`), with Enter inserting a chosen result and Cmd+Enter opening.
- `selfHit` returns no row for an external target: `parseInternalLink` returns null for `http`, `mailto` and `#` targets.
- The editor's context menu already offers to open the URL under the pointer (`externalUrlAtCoords`).

## Desired contract

1. A plain click on a URL link, `[label](https://...)`, behaves as a click on a file link: the caret lands in the link at the end of its target, the source is revealed for editing, and the link picker opens with an `OPEN <url>` row that opens the URL with the desktop opener on Enter or Cmd+Enter or a click on the row. Nothing opens until one of those.
2. The same holds for an autolink (`<https://...>`) and a bare URL the editor renders as a link, for `mailto` and `tel`, and for a `chan://graph` link, whose row opens its graph tab.
3. Cmd+click on macOS and Ctrl+click elsewhere open a URL or a `chan://graph` link at once, as a plain click does today.
4. For a URL the picker lists nothing below the `OPEN <url>` row, and the row carries a button that copies the URL to the clipboard, with the copy icon the file details panel uses beside a file's full path (lucide `Copy`, the `copy-btn` in `components/FileInfoBody.svelte`).
5. The context menu's open action is unchanged.

## Decisions

The owner's words of 2026-10-31 on the questions the item first left open: "yes, cmd+click / ctrl+click does open the url at once, and chan://graph links follow; about showign something below the URL: don't think so, but we should include a button to copy the url in that dialog - id like to use the icon for copy which we already use on the 'details' window on 'show file path' for example".

## Acceptance

1. Editor tests pin that a plain click on a URL link, an autolink, a bare URL and a `chan://graph` link calls no opener, puts the caret in the link's target and opens the picker with an `OPEN <url>` row and nothing below it; that choosing the row opens the link once; that the copy button puts the URL on the clipboard; and that a Cmd+click or a Ctrl+click opens at once. The file-link behaviour is unchanged. The new cases are red before the change.
2. In chan-desktop, a click on a URL in a document reveals it for editing, Cmd+Enter in the picker opens it in the default browser, the copy button copies it, and Cmd+click opens it at once.

## Closing evidence - 2026-11-01

The editor handles a primary press on a rendered external or `chan://graph` link by focusing the editor and placing the caret at the end of its URL target. Handling the press keeps the target available when revealing its source changes the DOM before `click`; Cmd/Ctrl-press opens the target immediately. The body context menu's URL lookup and the internal file-link handler keep their existing routes.

The raw link picker recognizes URL, autolink, bare URL, `mailto`, `tel` and graph targets. Its OPEN row opens the target on Enter, Cmd/Ctrl+Enter or a row press; external targets have no file candidates below it. The row's copy button uses the file details panel's Copy glyph and shared `copy-btn` style and calls the shared clipboard writer. Editor tests for URL placement, picker actions, copy, modifiers and file-link preservation were red on the base; the focused suite passes 68 cases. Six isolated mutations of the plain-press path, modifier path, OPEN row, copy action, file-search suppression and path-search suppression each failed the corresponding assertion.

An isolated Chrome check opened `ws-alpha/urlclick.md` after a hard reload and observed source reveal and a caret at the target's end for a markdown URL, an autolink and a bare URL, each with one OPEN row and a copy button. The file link showed `OPENnotes.md` and `PATHnotes.md`; Ctrl+click reached the page's desktop-opener call once. Chrome denied clipboard write permission, so the browser could not verify an actual clipboard value; the unit test verifies the URL passed to the clipboard writer. Screenshots, sanitized readings and logs are in `dev/v0120-team/evidence/Editor120/`. The chan-desktop Cmd+Enter, Cmd+click and clipboard smoke remains for Alex's Mac check.
