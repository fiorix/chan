# The rest of the frontend review has no owner

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0. v0.100.0 took 52 of the frontend review's 166 high and medium findings, and four sibling items here take the ones that are one piece of work each (source-text tests, repeated shapes, comments and dead code, mirrored contracts). This item is the ledger for what is left, so it does not become a second parked list. The mediums were re-verified against `main` at `d3de0180b` and all still apply; the lows were not.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, after [frontend-comments-narrate-history](frontend-comments-narrate-history.md) in the frontend rounds. It starts with a reading lane like the one over the Rust side-effect and error-handling lows ([the-side-effect-and-error-lows-are-unread](the-side-effect-and-error-lows-are-unread.md)): a disposition for each medium finding and each bug or side-effect low, with the ruling each one waits on. Fix lanes by area follow, highest consequence first. Of the five rulings this item needs, the workspace demo is settled by [frontend-comments-narrate-history](frontend-comments-narrate-history.md)'s ruling (it stays); the owner gives the other four (graph filesystem mode, non-markdown surfaces rewriting files, how snippets cross the wire, and what a multi-selection means for destructive actions) when the reading lane reports, with its evidence in hand.

On 2026-09-26, with the reading lane's evidence in hand, the owner gave the four rulings: graph filesystem mode stays supported and its four lows are fixed; no non-markdown surface writes a file without a user edit, and the first real edit may normalize; search snippets cross the wire as raw text with bare `<b>` markers, fixed on the Rust side, with no client change; destructive file-browser verbs act on the whole selection behind one confirm naming the count, report partial failures and clear the selection. The reading is done: the 47 mediums and the 116 lows filed as bugs or side effects (the item's 88 and 28) each have a disposition in the round's ledger, `dev/v0101-team/ferem-ledger.md` in the development tree, with the fix lanes by area in its two reports; the fix lanes follow.

## What was seen

**47 medium findings that are defects or hardening on their own**, with no shared mechanism to group them under. By area: the editor holds 19 (a `.json5` file opens in a tree that cannot parse it and can never be saved; opening an Excalidraw board rewrites the file with no edit; the style toolbar hides itself in source mode and cannot be brought back; closing the find bar drops focus to the body; ordered task-list items render no checkbox; a multi-megabyte JSON file mounts every node expanded), the app shell and panes 5 (the pane-body edge-split drop is dead because `dragover` reads a payload browsers never expose; one animation fades to a permanently blank pane after about seven minutes), the file browser and inspectors 4 (Delete acts on the cursor row while cut, copy and drag act on the selection; the expand chevron wipes a multi-selection), commands and search 4 (a Shift-only chord is assignable and then swallows capital letters everywhere; BM25 snippets are HTML-escaped twice), the workspace demo 5, the launcher and the shared deck 3, the terminal 2, the graph 2, and one each in the host bridge, the team dialog and the e2e harness.

Several wait on a decision more than on work: whether graph filesystem mode is still supported (deprecating it makes four fixes moot), whether the workspace demo is revived or retired, whether non-markdown surfaces may rewrite files they did not have to, whether snippets cross the wire escaped or raw (a Rust-side ruling), and what a multi-selection means for destructive actions.

**437 low findings nobody has read as a set.** By kind: stale 94, bug 88, hardening 58, dedup 54, side-effect 28, idiom 23, a11y 19, comment 19, contract 17, perf 16, structure 9, test 7, tooling 5. The 88 filed as bugs and the 28 as side-effects are the ones worth a read each.

**4 findings deliberately not scheduled**: the proposals to split `tabs.svelte.ts` (7,470 lines), `store.svelte.ts` (5,798), `GraphPanel.svelte` (3,552) and `TerminalTab.svelte` (3,073). The review names the seams and advises against cutting them alongside other work; they are recorded in the design documents and revisited when a feature needs one opened.

The working ledger, one row per finding with its verdict at HEAD and its target, is `dev/frontend-review-status.md` in the round's working tree, beside the five re-verification reports the round wrote before it opened.

## Desired contract

Every remaining finding ends with a disposition: fixed, refuted with the reason, folded into a sibling item, or carried with the reason. The mediums are taken by area, highest consequence first; the bug and side-effect lows get a read each; the other lows are folded by whoever is already in the file, under the same two rules as the Rust review's lows.

## Boundaries

The five `web/` packages, `desktop/src` and `scripts/e2e`. A finding that needs an owner ruling waits for it and says which. The review's proposed fix is a suggestion: the re-verification found six fixes that do not work as written, and one finding whose stated consequence was wrong about the server.

## Acceptance

1. Each of the 47 mediums has a disposition at GA, with the `path:line` it was re-verified at.
2. Each bug and side-effect low has a disposition; the other lows have a count folded and a count left.
3. The release report records the ledger's counts, and what is still open carries forward as this item.

## What shipped

Landed on 2026-09-26, from the multi-selection ruling (the ledger's FB-06 and FB-03). Delete on the Files tree acts on the whole selection behind one confirm that names the count, and says "permanently" in a window with no workspace; it sends one delete per path, reports a partial delete as "deleted N of M" with the first refused path and its error while the refused rows stay selected, clears the selection after a full delete, and closes the tabs under a deleted path. In a workspace a path under a selected directory folds into it; a window with no workspace deletes every selected path deepest first, since its route deletes only a file or an empty directory. A tree refresh that fails after the delete is reported beside the count. The expand chevron no longer arms the rubber band that cleared a multi-selection. Download and Rename keep the cursor row, as the ruling says.
