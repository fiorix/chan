# A keyboard reader entering the embedded demo meets the launcher controls behind its dialog

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-12 from its reading of the manual scroll range (the note N1 of `reviews/review-Review106-mscroll-range-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that range; owner the frontend seat; dispositioned at the candidate: built and proved if reached after the lane's committed items, else recorded with the reading below.

## What was seen

On `/manual/devserver/` the embedded launcher demo opens its devserver dialog by itself at load. After the manual scroll repair (`549bf15cb` on the frontend branch) that dialog takes no focus, so focus at load is on the page's body, and the keyboard is the way in for a reader who does not click. The review seat measured, in Chrome 155 at 1280x800 at that commit, in its guest: Tab from the page's last link before the frame enters the frame on the launcher's controls behind the dialog's backdrop, seven stops in order (Show gateways, Open command launcher, Select, Collapse windows, New local terminal, New local workspace, Add devserver); the eighth Tab is the dialog's Close; the dialog's six stops then wrap, so 24 Tabs do not leave the frame; Escape closes the dialog and eight more Tabs leave the frame for the page's next link; Shift+Tab from below enters on the dialog's last control directly (`evidence/Review106/mscroll-reader-probe-run.log` in the bus). The base before the repair reads the same seven stops for a reader who tabs in from a page link; the repair did not introduce them, it made this the only keyboard way in.

By source: the launcher's modal declares `aria-modal="true"` (`web/packages/web-shared/src/Modal.svelte`), and nothing makes the surface behind it inert. In the launcher's own window the helper's mount focus and its Tab wrap keep the keyboard inside the dialog; in the embedded demo's automatic dialog, which takes no focus by design, nothing does until the reader reaches the dialog through the seven covered controls.

Not established: what a screen reader announces for the seven covered controls (a modal that declares itself modal while its background stays in the tab order is the shape assistive technology does not expect, but no reading was taken); the owner's browser and viewport; whether the Install page's demo, whose dialog the reader opens by a click, has the same tab order while its dialog is open (not measured); whether the workspace app's own modal shell shares the shape.

## Desired contract

While a dialog is open in the embedded demo, a keyboard reader who tabs into the frame reaches the dialog's controls first and the controls behind the backdrop are not in the tab order; when the dialog closes, they are again. The launcher's own window keeps the behaviour it has (the mount focus, the Tab wrap, Escape).

## What to do

Measure first at the repair's tip, with the review seat's reading as the base: the stop list from the page's last link before the frame, with the dialog open and after Escape. Then the smallest repair in the launcher's shell, read against the modal's source: the surface behind an open dialog made inert (the `inert` attribute on the launcher's main surface while a dialog is open, removed when it closes) is the first candidate; the helper is touched only if the design needs it, and the design says why. The pin is a launcher unit test that with the dialog open the controls behind it are not focusable and after it closes they are, red before the repair on its own assertion; the browser check's interaction arm gains a keyboard-entry arm (Tab from the page link before the frame lands on the dialog's Close; after Escape the next Tab enters the launcher's first control), red at the base.

## Boundaries

`web/packages/launcher/` (the shell that renders the dialog over its surface) and its tests; `web/packages/web-shared/src/Modal.svelte` or `modalFocus.ts` only if the design names them with the reason; the browser check `scripts/e2e/manual-scroll.mjs` for the new arm. Not changed: the manual scroll repair (the automatic dialog still takes no focus), the marketing embed's template and stylesheet, the workspace app's modal shell unless it shares the shape (then noted here, not repaired here), the dialog's own tab wrap.

## Acceptance

1. The base reading at the repair's tip recorded here: the stops from the page's last link before the frame with the dialog open, in order, in Chrome at 1280x800, with the commit.
2. After the repair, Tab from that link lands on the dialog's Close and Shift+Tab from the page's next link lands on the dialog's last control; the unit pin red before the repair on its own assertion and green after.
3. After Escape the launcher's controls are reachable again in their order; a pin, red under the mutant that leaves the surface inert.
4. The launcher's own window unchanged: the existing modal and focus tests green at the commit, the interaction arm of the browser check green.
5. `make web-check` and `make web-marketing-check` green at the commit in the owning guest.
6. The repaired site is what the owner reads at `chan.app` after the next deploy of the marketing site, which is the owner's to authorize.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "dmtabs, the embedded demo's tab order behind its dialog: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
