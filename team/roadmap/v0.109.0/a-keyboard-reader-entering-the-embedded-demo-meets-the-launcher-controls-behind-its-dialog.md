# A keyboard reader entering the embedded demo meets the launcher controls behind its dialog

Status: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-12 from its reading of the manual scroll range (the note N1 of `reviews/review-Review106-mscroll-range-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that range; owner the frontend seat; dispositioned at the candidate: built and proved if reached after the lane's committed items, else recorded with the reading below.

## What was seen

On `/manual/devserver/` the embedded launcher demo opens its devserver dialog by itself at load. After the manual scroll repair (`549bf15cb` on the frontend branch) that dialog takes no focus, so focus at load is on the page's body, and the keyboard is the way in for a reader who does not click. The review seat measured, in Chrome 155 at 1280x800 at that commit, in its guest: Tab from the page's last link before the frame enters the frame on the launcher's controls behind the dialog's backdrop, seven stops in order (Show gateways, Open command launcher, Select, Collapse windows, New local terminal, New local workspace, Add devserver); the eighth Tab is the dialog's Close; the dialog's six stops then wrap, so 24 Tabs do not leave the frame; Escape closes the dialog and eight more Tabs leave the frame for the page's next link; Shift+Tab from below enters on the dialog's last control directly (`evidence/Review106/mscroll-reader-probe-run.log` in the bus). The base before the repair reads the same seven stops for a reader who tabs in from a page link; the repair did not introduce them, it made this the only keyboard way in.

By source: the launcher's modal declares `aria-modal="true"` (`web/packages/launcher/src/components/Modal.svelte`, with the focus helper `web/packages/web-shared/src/modalFocus.ts`), and nothing makes the surface behind it inert. In the launcher's own window the helper's mount focus and its Tab wrap keep the keyboard inside the dialog; in the embedded demo's automatic dialog, which takes no focus by design, nothing does until the reader reaches the dialog through the seven covered controls.

Not established: what a screen reader announces for the seven covered controls (a modal that declares itself modal while its background stays in the tab order is the shape assistive technology does not expect, but no reading was taken); the owner's browser and viewport; whether the Install page's demo, whose dialog the reader opens by a click, has the same tab order while its dialog is open (not measured); whether the workspace app's own modal shell shares the shape.

## Desired contract

While a dialog is open in the embedded demo, a keyboard reader who tabs into the frame reaches the dialog's controls first and the controls behind the backdrop are not in the tab order; when the dialog closes, they are again. The launcher's own window keeps the behaviour it has (the mount focus, the Tab wrap, Escape).

## What to do

Measure first at the repair's tip, with the review seat's reading as the base: the stop list from the page's last link before the frame, with the dialog open and after Escape. Then the smallest repair in the launcher's shell, read against the modal's source: the surface behind an open dialog made inert (the `inert` attribute on the launcher's main surface while a dialog is open, removed when it closes) is the first candidate; the helper is touched only if the design needs it, and the design says why. The pin is a launcher unit test that with the dialog open the controls behind it sit inside an `[inert]` boundary and after it closes they do not, red before the repair on its own assertion; the browser check's interaction arm gains a keyboard-entry arm that asserts the tab order (Tab from the page link before the frame lands on the dialog's Close; after Escape the next Tab enters the launcher's first control), red at the base.

## Boundaries

`web/packages/launcher/` (the shell that renders the dialog over its surface) and its tests; `web/packages/launcher/src/components/Modal.svelte` or `web/packages/web-shared/src/modalFocus.ts` only if the design names them with the reason; the browser check `scripts/e2e/manual-scroll.mjs` for the new arm. Not changed: the manual scroll repair (the automatic dialog still takes no focus), the marketing embed's template and stylesheet, the workspace app's modal shell unless it shares the shape (then noted here, not repaired here), the dialog's own tab wrap.

## Acceptance

1. The base reading at the repair's tip recorded here: the stops from the page's last link before the frame with the dialog open, in order, in Chrome at 1280x800, with the commit.
2. After the repair, Tab from that link lands on the dialog's Close and Shift+Tab from the page's next link lands on the dialog's last control; the unit pin red before the repair on its own assertion and green after.
3. After Escape the launcher's controls are reachable again in their order; a pin, red under the mutant that leaves the surface inert.
4. The launcher's own window unchanged: the existing modal and focus tests green at the commit, the interaction arm of the browser check green.
5. `make web-check` and `make web-marketing-check` green at the commit in the owning guest.
6. The repaired site is what the owner reads at `chan.app` after the next deploy of the marketing site, which is the owner's to authorize.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "dmtabs, the embedded demo's tab order behind its dialog: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.

## Built 2026-10-22

The launcher repair is `4b8db0eb17ca138c019c528d9b4f264486024613` over `ab3d3c1c4`. The `.launcher-surface` containing the covered controls becomes inert for any launcher dialog while the dialog and live notice regions remain outside it; the surface uses `display: contents` to retain the demo layout. The automatic Devserver dialog still takes no focus at mount, and the launcher captures a person-focused opener before setting the dialog open.

At the exact integrated base `369311697`, the Chrome verify JSON showed the forward Tab entering on Show gateways (`inDialog:false`), while reverse Shift+Tab entered on Add devserver and the seven launcher controls were reachable after Escape; those latter two legs were already green guards. The Install demo's focus-return arm at that base was `{before:true,opened:true,returned:true}`. With inert applied and synchronous return still in place, the focus-return arm became `{before:true,opened:true,returned:false}`; after the repair it returned true again. A Svelte 5.56.4 compile probe (`dev/v0109-team/evidence/Review109/dmtabs/order-probe-2.log`) shows the `{#if}` dialog teardown precedes the `template_effect` assigning `div.inert = false`, so the shared helper's synchronous `focus()` ran while the opener was still inert and Chrome ignored it.

The launcher `Modal.svelte` therefore uses the unchanged shared `modalFocus.ts` for entry, Tab wrapping and Escape with its existing `restoreFocus: false` option, then restores its captured opener after `await tick()` if the opener is connected, focus is on the body or null, and any remaining launcher dialog contains it at the top. The stacked-dialog pin returns focus into a surviving dialog; a focused replacement, a non-focusing replacement whose opener is behind it, and a detached opener do not receive that return. This moves the standalone launcher's return one closing flush later; the existing `Modal.test.ts` return assertion now awaits that flush. The launcher and workspace-app design sentences were corrected in the same commit.

The mounted `LauncherDemo.test.ts` pin was red at the parent on the seven controls' missing inert ancestor, red under a leave-inert mutant after close, and green at the repair; it also pins Close and an alert notice outside inert, and keyboard focus returning to Add devserver. jsdom needs two test-only browser approximations: the shim reflects the `inert` IDL property into the attribute, and it refuses `focus()` into `[inert]` while blurring an active descendant when inert begins. Without them jsdom accepts focus that Chrome refuses and hides the focus-return regression. Five focus mutants went red on their intended pins: dropped restore on the mounted return and the focus-return arm, synchronous restore on the same checks, dropped `isConnected` on the detached-opener pin, dropped focus-lost check on the focused-replacement pin, and dropped top-dialog clause on the non-focusing-replacement pin.

The final committed-state gate ran in `chan-v0109-hygiene` as ubuntu with one Vitest worker: launcher modal and mounted focus tests, shared modal-focus tests, `make web-check`, `make web-marketing-check`, `make e2e-check`, the marketing build and the Chrome verify check all exited 0. The Chrome JSON parser checked the two new arms by name, all 36 checks' `pass`, `verdict:"passed"` and zero failures; forward Tab reached dialog Close, reverse Shift+Tab reached dialog Add devserver, Escape restored the seven launcher controls, and the Install demo's focus-return arm was `{before:true,opened:true,returned:true}`. Raw statuses, the JSON and the red and green logs are under `dev/v0109-team/evidence/Hygiene109/dmtabs/`: the guest archive `guest-evidence.tar.gz` (sha256 `6fe144ed746a7edc8b046b12c16772cf3541dc30ed2fbd44da9de7f6a2f470c1`) extracted under `guest/`, with the parsed browser results in `guest/commit-gates/browser-parsed.json`.

The base reading of acceptance 1: at `b632113db`, Chrome 156.0.8078.47 at 1280x800, Tab from "Connect from the main window" reached the seven covered controls in order, Show gateways, Open command launcher, Select, Collapse windows of This machine, New local terminal, New local workspace and Add devserver, and the eighth Tab reached the dialog's Close; the six dialog stops wrapped, and Shift+Tab from "Open remote terminals and workspaces" entered on the dialog's last Add devserver button (`dev/v0109-team/reports/design-Hygiene109-dmtabs.md`).

Acceptance: 1 is the base reading above; 2 the Chrome keyboard arm (forward Tab on the dialog's Close, Shift+Tab on its Add devserver) with the mounted pin red before the repair and green after; 3 the seven controls reachable after Escape, with the leave-inert mutant red; 4 the existing modal and focus tests green at the commit with the return assertion awaiting the closing flush, and the interaction arm green; 5 `make web-check` and `make web-marketing-check` green at the commit in the owning guest; 6 not established in the round: the repaired `chan.app` site is what the owner reads after the next deploy of the marketing site, which is the owner's to authorize. The round did not measure a screen reader, the owner's browser or viewport, or the workspace app's own modal shell.
