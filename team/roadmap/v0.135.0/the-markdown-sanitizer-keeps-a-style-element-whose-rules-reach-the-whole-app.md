# The Markdown sanitizer keeps a style element whose rules reach the whole app

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0, so the GA commit moves it to the next version (D125).

Record: A1 of the review of the unfocused-survey row's hardening, outside that range and older than it (`dev/v0135-team/reviews/review-u5-h.md`, "A1"). The lead sent it to the owner as a candidate row, "the sanitizer's style policy per caller" (`dev/v0135-team/decisions.md`, D63; `dev/v0135-team/status.md`, For Alex, "U5 adjacent (review-u5-h A1, probe and reading)"). The same review's S1 found that a kept `<style>` element is also a spelling of the survey body's stated limit; [the unfocused-survey row](a-survey-over-an-unfocused-pane-takes-tab-and-its-keys.md) states that limit and leaves the policy to this row ("The stated limits, 2026-11-26").

## What is there now

Read at `aabb9d039`, by reading, except the probes named. Paths are under `web/packages/workspace-app/src/`.

- The three Markdown renderers sanitize with one DOMPurify config, which adds the embed iframe and its attributes and forbids nothing beyond DOMPurify's defaults (`SANITIZE_OPTS`, `api/markdown.ts:85-98`; `renderMarkdown` `:106-112`, `renderMarkdownWithBreaks` `:120-127`, `renderMarkdownInline` `:134-137`).
- Probe P2, under jsdom: DOMPurify keeps a `<style>` element that follows other content in the body; a leading one is dropped. Probe P3, a mounted test under jsdom: a `<style>` element in the body of an unowned survey hid the other pane, its computed `visibility` going from `visible` to `hidden` (review-u5-h S1 and A1; readings in `dev/v0135-scratch/Lead135/review-u5-h/p2-readings.txt` and `p3-readings.txt`). The reviewer ran no browser.
- The callers, each inserting the sanitized HTML: a survey body (`components/BubbleOverlay.svelte:266`, the only caller of `renderMarkdownWithBreaks`); the link preview popover, from a workspace file's text (`editor/overlays/preview_popover.ts:154`); Copy as HTML (`editor/copy_html.ts:181`); the printable document view (`editor/doc_dom.ts:127`); slides (`editor/slide_dom.ts:144`); the table widget's cells (`editor/widgets/table.ts:81`).
- That a workspace Markdown file with a `<style>` element restyles the app while it shows in the preview popover is inferred by the review, not probed. Which of the other callers put their HTML into the app's own document, and whether a slide or a printable document relies on a kept `<style>` today, is unread.
- The survey's design text names a kept `<style>` element as one way a body can make an element editable, a shape the unfocused-survey rule does not reach (`design.md:217`).

## Desired contract

1. Markdown rendered into the app's own document cannot restyle the app: a `<style>` element from it is not kept, or its rules reach nothing outside the element that shows it.
2. The policy is chosen per caller, as the record recommends: the survey body and the preview popover at least; each other caller is read at the build and its policy recorded here.
3. If the survey body no longer keeps `<style>`, the survey's design text and the overlay comment drop that spelling from the stated limit (review-u5-h S1: forbidding it in the survey's call leaves the inline `style` attribute as the only spelling).

## Boundaries

- The sanitizer's config in `api/markdown.ts`, each caller's choice of it, their tests and the design text.
- Not here: the embed iframe allowlist, and inline `style` attributes.

## Acceptance

1. Unit tests, red at the base: for each caller whose HTML enters the app's document, a body with a `<style>` element after other content keeps no rule that reaches outside it. P3's shape as a mounted test: a survey body's `<style>` leaves the other pane visible.
2. A browser check in an isolated guest: a survey whose body carries a `<style>` rule aimed at the panes, and the preview popover over a workspace file with one, leave the app's look unchanged. Red at the base, green at the tip.
3. The reading of the other callers (whether each inserts into the app's document, and whether a slide or a printable document uses a kept `<style>`) is recorded here before their policy is set.

## The options as drafted

- (a) Per caller: no `<style>` element where the HTML enters the app's own document; kept where the caller's output leaves the app or is isolated (recommended, the record's "style policy per caller").
- (b) Forbid `<style>` for every caller in the shared config: the simplest, and it drops any styling a slide deck or a printable document gets from one.
- (c) Keep `<style>` and scope its rules to the element that shows it (a shadow root or a scoped stylesheet): the largest change.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("app and workspace recommendations are good to me", `dev/v0135-team/decisions.md`, D125), answering the candidate rows of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "Sanitizer"). Drafted as a lead document and not built in v0.135.0, so the GA commit moves it to the next version (D125). The options above are the lead's draft, with (a) recommended; the owner's word did not choose among them.
