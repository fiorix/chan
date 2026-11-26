# A press beside a survey card drops the keyboard, and a survey body's link navigates the app away

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125).

Record: two findings about a per-terminal survey's pointer handling, accepted as one row ("the survey overlay press together with the survey body links", `dev/v0135-team/decisions.md`, D125). The press: check 5 of the owner's Mac file had a control step, "click into SurveyA's terminal and press 2", which failed on WebKitGTK (D123 item 2); attributed base against tip, it was a wording error in that file and pre-existing product behaviour, and whether the press should keep the keyboard on the card went to the owner as a product question (D123 amendment; `dev/v0135-team/evidence/reports/v0135-174-webkitgtk-ops-report.md`). The links: seen by reading while [the unfocused-survey row](a-survey-over-an-unfocused-pane-takes-tab-and-its-keys.md) was fixed (`dev/v0135-team/followups/followup-Widget135-Lead135-7.md`, "Known gaps"; `dev/v0135-team/status.md`, For Alex, "U5 adjacent"). The unfocused-survey row records both as outside its scope.

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
