# Release v0.117.1

Shipped 2026-10-31 as a same-day patch over v0.117.0, cut from `0.117.1-ga` with no release candidate, by the owner's words after reading the release on the macOS desktop: "the file browser we must fix now" and "go for it! we need the patch release asap". The branch holds, over `main` at the v0.117.0 publication record: the one-line fix of the Files tab's overflow with its browser check (`45a75c341`), the `brew trust` line the downstream workflow's Homebrew validation needs (`9c7e9ecd4`), the two rows the owner raised that morning (`99fff817b`) and the GA commit of the patch.

## What shipped

- `filesovf`, The Files tab overflows its pane and hides the tab strip: the folder list of the directory view is `position: relative` (the rubber band's anchor) and its scroller `.tree-wrap` was not, so the pane card counted the whole list as its own scrollable overflow (1,124 px for 990 in the seed workspace), and WebKit scrolled the card to a focused row, which took the pane's tab strip and the Details header out of view and left the status bar short of the bottom in the owner's capture on macOS. The scroller is positioned (`45a75c341`), so the list scrolls inside it and the card holds no overflow. Browser check 196 (`files-tab-keeps-the-pane-strip`) pins it.

Beside the row: the downstream workflow's Homebrew validation trusts the staged tap before auditing it (`9c7e9ecd4`), since Homebrew now refuses to load a cask from an untrusted third-party tap, which is what left the v0.117.0 tap publication red.

## Merge and review

No branch merge: the patch's commits were made on the release branch by the lead session, over the tagged v0.117.0 tip and its publication record, and `main` moves to the patch's GA commit by fast-forward. The fix was found by measuring the pane card's `scrollHeight` in headless Chrome while hiding subtrees and toggling style properties one at a time, after the owner's capture and words placed it; the cause and the alternatives that also removed the overflow (`contain: paint` or `display: flex` on the scroller, `overflow: hidden` on the surface's body) are in the item.

## Validation

- Browser check 196 against the v0.117.0 tree in the Linux guest: red at `Files tab open: the pane card holds 1124px of scrollable content in 990px`; against the fix, green three times in a row (about 2.1 s each): the card's `scrollHeight` equals its `clientHeight` and the strip stays at the card's top with both tabs listed, before and after the list is clicked, walked with ArrowDown, End, ArrowUp, Home and End, and its last row revealed and focused. The surface's vitest files (11 files, 88 tests) pass.
- Not read before the cut: the symptom itself in WKWebView or WebKitGTK, which no compositor on the build host could show that morning; the mechanism the fix removes is the one the owner's capture shows, and the owner reads the patch on macOS.
- The GA commit moves the version pins, the three lockfiles, both Nix fixed-output hashes with the lock digest, the Fedora specs and the documents. Before the tag the tip is proved by its own `make pre-push` on the build host, `make gateway-packaging-isolation-test`, and the dispatches on `0.117.1-ga`: `release.yml` with publish off, `ci.yml`, Gateway CI, `freebsd.yml` and `publish-downstream` twice with publish off (docker, cachix). `make windows-cross-check` is not run: this host's sdme refuses the guest's disk cap; Windows is covered by `ci.yml`'s Windows arm and the dry run's Windows packages.

- The proofs at the GA commit `153567aff`: its `make pre-push` on the build host green but for the AppImage bundle this host cannot strip (50 cargo test result lines, 6,119 tests passed; the web suites passed), and `make gateway-packaging-isolation-test` green. On `0.117.1-ga`, each green at its first attempt: Release 41189112253 with publishing off (macOS signing and notarization included), `ci.yml` 41189119467 (nine of nine, the Nix job and the Windows arm among them), Gateway CI 41189126727, `freebsd.yml` 41189134048, and `publish-downstream` 41189141455 (`targets=docker`) and 41190205607 (`targets=cachix`). GitHub's status page read operational on ten readings a minute apart before the tag. The tag script ran once in the session at 10:40Z and both pushes went through.
- Published on 2026-10-31 by the tag push at 10:40Z: the Release run 41193739980 on `v0.117.1` succeeded, the GitHub Release published with 25 assets at 11:40Z, and the `/dl` metadata reads 0.117.1 for the CLI and the desktop. On `main` at the GA commit, Gateway CI 41193738504 and `freebsd.yml` 41193738536 succeeded and `ci.yml` 41193738506 succeeded at 11:49Z. The downstream run 41197897565 started at 11:41Z and was building its Docker images, Cachix closures, COPR chroots, AUR packages and PPA sources at this push, with both COPR source packages built at 0.117.1-1 by 11:44Z; the freeze on `main` held until both COPR source packages were built.

## Retrospective

Highlights: the owner's capture and three sentences placed the bug, a measured search named the one line in under an hour, and the check that pins it reads the cause rather than the symptom, so it fails on the number a future regression would change.

Lowlights: the release that needed the patch had shipped a surface its browser suite could not drive, and the suite would not have seen this bug anyway: Chrome keeps the strip where WebKit scrolls it, so a geometry invariant had to stand in for the eye.

Honest feedback: a surface rewritten for a release should get a WebKit read before the tag, and the suite should assert the pane card's zero overflow for every tab kind, not for the Files tab alone.

## Follow-ups

- `tmuxfed`: a `tmux -CC` run over the gateway reaches the desktop as window rows with no connection record, so its card has no title, session line or actions; moved to v0.118.0 unbuilt by the owner's word.
- The Homebrew publication of v0.117.0 and v0.117.1: a retry of `publish-downstream` for the tap from `main` with the fixed validation step, on the owner's word.
- The v0.118.0 rows of the release: check 195's browser model and the suite's file-browser checks against the directory view.
