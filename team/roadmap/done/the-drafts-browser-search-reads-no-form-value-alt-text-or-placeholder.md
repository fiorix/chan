# The drafts browser search reads no form value, alt text or placeholder

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16; the section Landed 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: carried into v0.106.0 at the v0.105.0 GA on 2026-10-11, still raised for a decision.

Record before the release: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

The browser smoke checks of the drafts work assert that a page shows no draft path mark and no draft lifetime id. They do it through one helper, `assertNothingMarkedShown` in `scripts/e2e/browser-smoke/lib/drafts.mjs`, which searches what `readable(page)` returns. At the released tree `readable` joins the body's `innerText`, the body's `textContent`, and the `title` and `aria-label` attributes of every element that has one. A form control's current value, an image's `alt` and a `placeholder` are in none of those. Checks 130, 131 and 133 call the search (six calls, by a search of the suite for the helper's name), and its positive control, `assertMarkedShownIsRefused`, which check 130 calls once, plants a marked path in a `title`, the id as text and the percent-encoded id as text, so no arm of the control covers a form value, an `alt` or a `placeholder` either.

The record names the limit three times. The author's validation report (`dev/v0104-team/reports/validation-Frontend104-browser-b1b2.md`, "Gaps and what is not claimed"): "A form control's current `value`, an `alt` and a `placeholder` are in none of those, so a marked path in the Save to Workspace prompt's input, for one, would not be found by this search. Whether that belongs in the helper is for the reviewer and the lead." The review (`dev/v0104-team/reviews/review-Review104-browser-b1b2-1.md`, "The author's five points"): true at source, outside that change, a limit of the instrument to name in the report, and the lead had ruled it no task in that round. The closed item ([drafts-and-attachments-live-inside-the-workspace](drafts-and-attachments-live-inside-the-workspace.md), "Browser assertion follow-up landed 2026-10-08"): "form values, alt text and placeholders remain outside it, a source-read coverage limit unchanged by this repair." The release report repeats it in Follow-ups ("Broaden the browser search instrument if it must detect form values, alt text or placeholders") and in Known gaps (`team/release/release-v0.104.0.md`).

One sentence of the helper says more than it reads: the comment over `readable` opens "Everything a person can read or hear in the page" and then lists its text, titles and aria labels, and a person also reads an input's value and a placeholder and hears an image's alt text.

Engine: the checks ran in Chrome for Testing 155, headless, in a Linux guest with no GPU, alone and in the whole run of the candidate's and the GA commit's browser matrices, where every leg passed; the candidate's matrix ran debug binaries.

Not established: that any page of the product puts a draft's marked path or lifetime id into a form value, an `alt` or a `placeholder`. The limit is a source reading of the helper; the Save to Workspace prompt's input is the author's example of where one would go unseen, not an observed leak, and no run searched those places. Which drafts surfaces carry such fields was not listed. Nothing here was read in a native webview.

## Desired contract

The item asks for a decision: whether the drafts checks must find a mark or an id in form values, alt text and placeholders. If they must, the search reads those sources and each one has a positive control that requires its own refusal; if not, the helper's comment and the suite's README say what the search does not read.

## What to do

Read which surfaces of the drafts flows can put a draft's path or id into a form control, an image's `alt` or a `placeholder`, starting from the one the record names, the Save to Workspace prompt's input, and list them with the source line that fills each. Put that list and the choice to the lead. If the search is widened, build it red first: a plant for each new source in the control, failing at the commit before the search reads it.

## Boundaries

`scripts/e2e/browser-smoke/lib/drafts.mjs`, checks 130, 131 and 133 under `scripts/e2e/browser-smoke/checks/`, and the suite's `README.md`. The helper keeps leaving URLs out, since an image's address rightly carries its draft's id, as its comment says. No product file: a leak that a wider search finds gets an item of its own.

## Acceptance

1. A written list of the drafts surfaces whose form values, alt text or placeholders can carry a draft's path or id, from a source read, with the decision recorded beside it.
2. If the search is widened: it reads each decided source; the control plants one value in each and requires that source's own refusal; the control is red at the commit before the widening on exactly the new plants and on nothing else.
3. Checks 130, 131 and 133 pass alone at the tip with no skip, in the suite's Chrome; a red there is read and kept, not run again until green.
4. If the search is not widened: the comment over `readable` and the suite's README state what it does not read.
5. The record names the browser and says that no native webview was observed.

## The surface reading and the lead's decision 2026-10-13

Acceptance 1, the list (the frontend seat's reading at `6f1589372`, `dev/v0106-team/tasks/task-Frontend106-Lead106-17.md`, with the source line that fills each): the Save to Workspace prompt's path input, seeded from the inspected draft's name or its default target (`state/tabs.svelte.ts` 4090 to 4127, 3037 to 3048; `PathPromptModal.svelte` 45 to 48 and 697 to 707); the Close Draft destination input, seeded the same way (`tabs.svelte.ts` 3992 to 4004; `DraftCloseModal.svelte` 63 to 66); a standalone draft's path in the file tree's rename prompt (`FileTree.svelte` 757 to 759; `store.svelte.ts` 6183 to 6190); a draft editor's Markdown image widget, whose `alt` is the authored alt text (`editor/widgets/image.ts` 1310 to 1317, 1391 to 1396, 626 to 629); the image picker's preview, whose `alt` is the raw URL text or a catalog hit (`editor/bubbles/image.ts` 231 to 254; in a standalone window the catalog is the tree, so a draft image's real path can fill it); the standalone draft image inspector's preview `alt`, the entry's basename (`FileInfoBody.svelte` 153 to 175, 949 to 985); authored content in a CSV cell or a search query seeded from a selection. None of these inserts the marked client path or the lifetime id by itself: the prompts carry the draft's name and proposed destination, the `alt` surfaces carry authored text or a basename, and no draft-flow `placeholder` is filled from draft data (the two prompts' placeholders are fixed examples). The checks search only after the prompts close, so a wider search called where it is called today cannot observe a prompt's value. Acceptance 3 at the reading's tip: checks 130, 131 and 133 alone, each `ALL GREEN (1 ran)` with no skip, in the guest's headless Chrome for Testing 155 (acceptance 5: no native webview was observed); a first build attempt stopped before Cargo on a non-login shell's `PATH` and is kept.

The decision: widen. The helper's comment claims everything a person can read or hear and its search reads body text, titles and aria labels; the reachable surfaces are the two prompts' live values and an image's `alt`, and the claim must match the reach or the record is false. The search reads current form-control values, `alt` and `placeholder`, each with its own plant in the control and its own refusal, red at the commit before the widening on exactly the new plants (acceptance 2); checks 130 and 131 gain a search while the Save and the Close prompt are open, so the prompts' values are observed where they exist; URLs stay excluded as the boundaries keep; the comment and the README say the reach and the exclusion. Test-only, within the item's boundaries; a leak the wider search finds gets an item of its own. Built by the frontend seat as task 24, reviewed before integration.

## The commit's home at the v0.106.0 GA 2026-10-15

The commit this item waits on, `5d4f1046e7eaefc829abe7d590082c19e50cb558` on the seat branch `v0106/frontend` (not landed on the integration branch), is kept as the patch `dev/v0106-team/evidence/Lead106/ga/carried-patches/srchfm/0001-test-browser-search-draft-form-values-alt-text-and-p.patch` in the round's bus, which the round's archive carries after the seat branches are deleted at the teardown; it applies on the integration tip `671e49126` (`git apply --check` at the cut).

## Landed 2026-10-16

The carried patch was applied on `079d88f770f9edc6f6cb522e73383640ae5f49ef`, with the independent review's missing Close Draft search in check 131 and the URL exclusion's reason folded in. `readable` reads body text, titles, aria labels, current input, textarea and select values, image alt text, and placeholders. URLs stay excluded because a draft image's address carries its lifetime id. Checks 130 and 131 search with each Save to Workspace and Close Draft prompt open, before its destination input is overwritten or the prompt is dismissed. The comment and suite README state the reach and exclusion. No product file changed.

Acceptance 2 was proved by mutation of the helper at its committed content (`lib/drafts.mjs`, sha256 `fc8d9a371701da49138d33a24121a23bce92838e4c9ff9e6fa048c03027b96a9`), on the new base. The control plants a marked path in a live input value, the raw id in image alt text and the percent-encoded id in a placeholder, each separately, and requires each source's own refusal. Removing all three reads made check 130 fail on exactly those three plants; removing only the value, alt or placeholder read made it fail on that plant alone. The title and text plants still passed. Each mutation was run once, returned exit 1, retained its diff and hash, and restored the guest clean. These failures reach `assertMarkedShownIsRefused`, not a missing function or an earlier assertion. The helper's hash is the same at the item's commit.

Acceptance 3: `SMOKE_SKIP_BUILD=1 SMOKE_ONLY=130 node scripts/e2e/browser-smoke/run.mjs`, then the same command with `131` and `133`, each returned exit 0 and `ALL GREEN (1 ran)`, no skip. The documented harness command, `node --test --test-concurrency=2 scripts/e2e/browser-smoke/lib/terminal-cut-proxy.test.mjs`, returned exit 0 with 31 passed and no skips. `node --check` passed for the helper and all three checks; `git diff --check` passed. The guest's base-built binary and every bundle file matched their recorded SHA-256 values, and the source delta from the build revision held only browser tests and roadmap records. Each run used a disposable workspace, home and server in the owning guest.

Evidence is under `dev/v0107-team/evidence/Hygiene107/srchfm/`: `mutant-all`, `mutant-value`, `mutant-alt`, `mutant-placeholder`, `alone-130`, `alone-131`, `alone-133` and `harness-tests` have logs, real statuses and host cgroup readings. The exported `results.json`, timelines, screenshots and mutation diffs are under `export-final/srchfm/`, which holds the mutants and the final runs. At the item's commit the final runs are `final-130`, `final-131` and `final-133` (each exit 0, `ALL GREEN (1 ran)`, no skip) and `final-harness` (31 passed), each with its log and status beside these runs. The wrapper's constructed invalid mode returned exit 2 before launching a browser. The environment is `dev/v0107-team/reports/environment-Hygiene107.md`: two CPUs, 8 GiB RAM, 44 GiB disk, explicit two-job/thread limits and disk-backed temporary storage. CPU throttling and the lifetime swap peak make this contended functional evidence, not a timing measurement; no OOM or OOM kill was observed.

Acceptance 1 is the surface reading and decision recorded above; acceptance 4 does not apply because the decision was to widen. Acceptance 5: Chrome for Testing 155.0.8059.84, headless Blink on Linux. No native webview was observed. The required search and refusals are built.
