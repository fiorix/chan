# The ghostty terminals run on a pre-1.0 libghostty-vt build

Status: ordered by the owner on 2026-11-08 in a self-contained work order (kept with the round's raw data) and built on `ghostty-vt-1.0` by a coordinator with agents; rebased onto the integration branch and merged as `c899d23b3` (`aff0ed5f4`, five commits, web only); accepted for v0.127.0 by the owner on 2026-11-09, when it was merged. Reviewed at the merge (the web code and check 211, read-only): merge, no blocking defect; its findings (find not told of a resize or of the lines chan writes at session end, a stale xterm count after Escape, a click in the find bar dropping the highlight, check 211 leaving its instrumentation in place, and smaller nits) go to the follow-up work order. On 2026-11-09 the owner ruled on the build report's open questions: the highlight must follow its match across a resize, the focus race is closed if possible, and the overlapping-match count, xterm's `? of 1000+` and the status pill over the count stay as they are; a follow-up work order for the first two is with the owner. Acceptance 1 is met (the integrator checked the hash, the signature and the key against upstream), and 2 at the merge (the web gate green, the workspace app's 8,955 tests among it); 3 is green in the branch's own guest at the tree before the merge, not yet at the merge; 4 waits on the follow-ups and 5 on the owner.

## What is there now

At the base chan's ghostty terminals, the default backend, run on a `tip` build of libghostty-vt from Ghostty's main branch (commit `ae0dc1b71`, 2026-10-31, reporting version `0.1.0-dev`). The vendored file is the only copy of that pin, because the `tip` release replaces its assets on every commit, and its C ABI is marked unstable. libghostty-vt 1.0.0 shipped on 2026-11-06 as a signed release with a semver-stable ABI, which the old pin breaks in several places, search among them. Find is switched off on ghostty terminals, because ghostty-web has no search addon, while xterm terminals find through `@xterm/addon-search` with no match count.

## Desired contract

1. The vendored core is the signed libghostty-vt 1.0.0 ReleaseFast wasm, checked against Ghostty's published hash and minisign key, with its provenance and the re-pin procedure in the vendor README.
2. chan's binding speaks the 1.0 ABI: every enum value, offset and flag it uses is checked against the build's own type manifest; the scrollback byte cap is unlimited, so a configured line limit is the only limit; grapheme clusters are read through 1.0's codepoint buffer.
3. A core whose major version is not 1, or that has no search, is refused at load, and the terminal falls back to xterm.js as it does when the wasm fails to compile.
4. Find works in ghostty terminals: typing selects the newest match; Enter and `app.find.next` step to older output, Shift+Enter and `app.find.prev` to newer, both wrapping; the active match is the selection, scrolled into view, with a "k of n" count that marks a partial total; a selection the user made is never taken over. xterm terminals follow the same direction and count.
5. The highlight and the count follow their match across every change to the terminal: output, the lines chan itself writes, and a resize (owner, 2026-11-09).
6. Reopening the find bar right after Escape leaves focus in the bar (owner, 2026-11-09: close the gap if possible).

## Boundaries

- ghostty-web's own pin stays; only the core is re-pinned.
- Highlighting every match is deferred.
- The core counts a match at every start position, overlapping ones included, and the count may differ from xterm's addon for such needles; xterm shows `? of 1000+` at the addon's 1,000-match limit (owner, 2026-11-09: both accepted).
- The transient status pill may cover the count while it shows (owner, 2026-11-09: no change for now).

## Acceptance

1. The vendored wasm's sha256 equals the release's `SHA256SUMS`, and its minisign signature verifies with the key Ghostty's `PACKAGING.md` lists.
2. The binding's ABI, differential and search tests are green over the vendored wasm, and a terminal configured for 10,000 lines keeps about 10,000 rows of history.
3. Browser check 211 (find in a ghostty terminal) and checks 93, 94, 105 and 204 are green in an isolated guest at the integration tip.
4. The resize and focus follow-ups are each pinned by a test, and check 211 covers a resize.
5. On chan-desktop (owner): ghostty terminals on the re-pinned core, then Cmd+F, Cmd+G and Cmd+Shift+G in one.
