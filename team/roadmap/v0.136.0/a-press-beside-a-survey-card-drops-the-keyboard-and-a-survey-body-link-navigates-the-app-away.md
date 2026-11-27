# A press beside a survey card drops the keyboard, and a survey body's link navigates the app away

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27.

Record: two findings about a per-terminal survey's pointer handling, accepted as one row ("the survey overlay press together with the survey body links", `dev/v0135-team/decisions.md`, D125). The press: check 5 of the owner's Mac file had a control step, "click into SurveyA's terminal and press 2", which failed on WebKitGTK (D123 item 2); attributed base against tip, it was a wording error in that file and pre-existing product behaviour, and whether the press should keep the keyboard on the card went to the owner as a product question (D123 amendment; `dev/v0135-team/evidence/reports/v0135-174-webkitgtk-ops-report.md`). The links: seen by reading while [the unfocused-survey row](../done/a-survey-over-an-unfocused-pane-takes-tab-and-its-keys.md) was fixed (`dev/v0135-team/followups/followup-Widget135-Lead135-7.md`, "Known gaps"; `dev/v0135-team/status.md`, For Alex, "U5 adjacent"). The unfocused-survey row records both as outside its scope.

## What is there now

Read at `aabb9d039`. The press is read in two engines; the links are by reading. Paths are under `web/packages/workspace-app/src/` unless named otherwise.

- A per-terminal survey's overlay covers its whole terminal around the card (`.survey-overlay` and `.survey-overlay.per-terminal`, `components/BubbleOverlay.svelte:317-339`). The overlay element (`:241-248`) has no pointer handler; the card is `tabindex="-1"` (`:253-258`).
- The press, read on WebKitGTK 2.52.6 with debug builds of the tip `08b5a96d1` and the base `3a34491ce`, event for event the same at both (v0135-174, readings 1 and 3): with pane B focused, a click on A's terminal above the card lands on `div.survey-overlay`, and its pointerdown, mousedown and click are not default-prevented. The press makes pane A active. During the mousedown the card takes focus; about 30 ms later, when the mousedown finishes, it loses focus and `document.activeElement` is `<body>`. A's terminal input never gets focus, and a typed `2` reaches neither PTY and answers nothing. With pane A already focused and the keyboard on the card, the same click blurs the card to `<body>`. A click on A's tab label or on the card, then `2`, answers. With no survey up, the same click focuses A's terminal and `2` reaches its PTY.
- In Chrome 156 headless at the tip (v0135-174, reading 4), the same click lands on the overlay, the keyboard ends on `<body>` and the `2` reaches neither terminal; with no survey up it reaches A's PTY.
- The links: a survey body is Markdown rendered and sanitized by `renderMarkdownWithBreaks` (`components/BubbleOverlay.svelte:266`, `api/markdown.ts:120-127`). By reading (Widget-7), its links carry no `target` and nothing in the workspace app handles their click, so in a plain browser following one navigates the app's tab away from the workspace. By the same hand-back's reading, chan-desktop has a new-window handler only for the Computers screen (`desktop/src-tauri/src/launcher_panel.rs:1058-1061`); what a followed body link does in a workspace window of chan-desktop is unread.
- The app opens external links elsewhere through `openExternalUrl` (`editor/external_links.ts:73-91`, used by the file editor and the terminal's link menu): in chan-desktop it hands an openable URL (http, https, mailto, tel) to the desktop's opener, and in a browser it opens a new tab.

## Desired contract

1. A press on a per-terminal survey's overlay outside its card makes its pane active, as today, and leaves the keyboard on the card, so a typed answer key answers that survey. The 174 report names two ways: the overlay cancels the mousedown, or the card takes the keyboard back after the press.
2. A link in a survey body never navigates the app's own tab or window away. An external link opens as the editor's do, through `openExternalUrl`. What a link to a workspace path does is decided at the build and recorded here.
3. A press on a body link while its pane is unfocused still makes its pane the focused one first, as the unfocused-survey row requires.

## Boundaries

- The overlay's pointer handling and the body's link clicks in `components/BubbleOverlay.svelte`, with their tests. The keyboard-owner arbiter is consumed, not changed.
- A window-wide survey's overlay is not in the readings above; whether its press needs the same is read at the build and recorded here.
- The sanitizer's policy for a body's `<style>` element is [the sanitizer row](the-markdown-sanitizer-keeps-a-style-element-whose-rules-reach-the-whole-app.md)'s.

## Acceptance

1. Mounted tests, red at the base: a press on the overlay outside the card leaves the keyboard on the card with its pane active, and a typed answer key answers; a body link's click is default-prevented and handed to the opener. One mutation per guard turns a case red.
2. A browser check in an isolated guest, on Chrome: v0135-174's reading (pane B focused, a click on A's terminal above the card, then `2`) answers A's survey; a click on a body link leaves the page's URL unchanged. Red at the base, green at the tip.
3. The same press and a followed body link on WebKitGTK in an isolated guest, and in chan-desktop in WKWebView on the owner's Mac.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125), answering the candidate rows of the round's hand-back and the overlay press the lead put to him with them (`dev/v0135-team/status.md`, For Alex: "should it keep the keyboard on the card?"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125). Contract 1 reads the owner's acceptance as a yes to that question; the owner's word did not state it separately.

## Decided, 2026-11-27: a body's links follow the editor's model

Asked what a survey body's link to a workspace path should do (open the file as an editor link does, or nothing), the owner answered on 2026-11-27: "yes i think we should display links on the survey like we do in the editor: a drop down with open document, open url, and then we open the links on cmd+enter or the click to open; we dont need to invent something new here, just reuse the editor model".

This replaces contract 2's open point and widens it: a link in a survey body, to a workspace path or to a URL, behaves as a link in the editor does, with the editor's menu of open actions and its two ways of opening (the modified Enter and the click), through the editor's own code and not a second implementation. Contract 2's first sentence stands: a body link never navigates the app's own tab or window away. What the editor's model is, piece by piece, and which of its pieces a read-only survey body can reuse as they are, is read at the build and recorded here before the first fix; acceptance 1 and 2 gain a case per piece. The owner did not speak to the keyboard staying on the card; contract 1 stands on his acceptance of 2026-11-26.

## Decided, 2026-11-27: a click opens the drop-down

Asked whether a plain click on a survey body's link shows the drop-down or opens the link at once, the owner answered on 2026-11-27: "3. open the drop down not the link directly; just like in our editor". A click on a body link shows the editor's drop-down; its open row, or the modified Enter, opens the link.

## The editor's model, read 2026-11-27, and what a survey body reuses

Read at `7fbd18f17` in the editor's write mode (its read mode shows no drop-down). In the editor a link is an external URL (`isOpenableExternalUrl`: http, https, mailto, tel), a graph link (`chan://graph?`), or a workspace path (`parseInternalLink`, resolved against the document's directory, the workspace root when the document has no path). With the caret in a `[label](url)` link's URL slot or a bare URL, the editor shows a drop-down whose first row reads OPEN and the href as written (`editor/bubbles/wiki.ts`); Enter or a press on that row opens it, Cmd or Ctrl with Enter opens it while the drop-down is open, and Cmd or Ctrl with a click on the link opens it without the drop-down. An external URL opens through `openExternalUrl`, a workspace path through `openLinkTarget`. A survey body carries no graph link: the sanitizer drops a `chan:` href.

A survey body reuses, unchanged, the classifiers and the resolver, the open actions, and the drop-down's shell (`openBubbleShell`) and styles. The OPEN row (what it shows, what it opens) moves out of the editor's drop-down into a module both call, with no change of behaviour. The editor's keymap and click handlers are CodeMirror's and are not reused: the card's keydown and one delegated click listener on the body call the shared pieces.

Contract items, on from 3 (owner answers 4 and 11, 2026-11-27; the lead's rulings D40):

4. A click on a link in a survey body is always cancelled, the middle button's included: the app's tab or window never navigates. "Link" is every `href` carrier the body renders (HTML `a` and `area`, SVG `a` by `href` or `xlink:href`, MathML `href`), and a click includes the one an engine makes from Enter on a focused link. A link whose target opens nothing (another scheme, a bare `#fragment`) shows nothing.
5. A plain click on a body link to an external URL or a workspace path shows the editor's drop-down under the link, with the one row OPEN and the href as written (and the copy button the editor gives an external URL). Enter or a press on the row opens the target; Escape or a press outside closes the drop-down and leaves the survey up and unanswered. A second click on the same link keeps the drop-down; a click on another body link moves it there.
6. Cmd or Ctrl with a click on a body link opens the target with no drop-down. Cmd or Ctrl with Enter opens the target while the drop-down is open; otherwise the key travels on as today.
7. A workspace path resolves against the workspace root. A path that leaves the workspace opens nothing. In a window with no workspace a path link shows nothing and opens nothing; an external link still shows its row.
8. While the drop-down is open the survey's own keys still answer (1 to 9, F, X); Escape closes the drop-down first, and a second Escape dismisses the survey. The drop-down closes when the survey is answered, replaced or hidden, when the survey stops owning the keyboard, and when the card scrolls.
9. Opening a link answers nothing. An external link leaves the survey showing. A workspace path opens in the survey's pane as that pane's active tab, as the editor's model does, so the survey's terminal tab is hidden and its survey stays pending, shown again with its tab.

Acceptance, added:

- Mounted, red at the base: (a) a plain click on an https link is default-prevented, nothing opens, and the drop-down shows OPEN and the URL; (b) Enter with the drop-down open opens the URL once; (c) a press on the row does the same; (d) Cmd-click and Ctrl-click open at once with no drop-down; (e) Cmd+Enter and Ctrl+Enter with the drop-down open open it; (f) `notes/a.md` opens through `openLinkTarget` (the resolve request sent) and `../x.md` shows nothing and sends nothing; (g) Escape with the drop-down open closes it and sends no reply, and a second Escape dismisses; (h) a `#fragment`, an `ftp:` link and an SVG `xlink:href` link are default-prevented and show nothing; (i) with the other pane focused, a press on a body link makes the survey's pane the focused one first and then behaves as (a); (j) in a window with no workspace a path link shows nothing and an https link still shows its row; (k) the drop-down closes when the survey is answered by a key while it is open. One mutation per guard. The pin "a press on a link in its body makes its pane the focused one and leaves the link its click" flips.
- Browser, Chrome, red at the base and green at the tip: a new check reads a body link's click as default-prevented from a bubble-phase listener after the app's, the drop-down's showing and styles, an external open by a stubbed `window.open`, and a seeded note opening as a tab in the survey's pane; check 348's `link-press` leg stops holding the default in the capture phase. Enter and Mod+Enter on a focused body link are read there, and in WebKitGTK and on the owner's Mac (acceptance 3).
