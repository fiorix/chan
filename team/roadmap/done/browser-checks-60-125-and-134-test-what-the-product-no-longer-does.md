# Browser checks 60, 125 and 134 test what the product no longer does

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: red in the whole browser suite at `038d82f42` and again at `b2665def0`. 60 and 125 had been recorded as this host's known reds, and 134 was red at `main` `720b543c0` too. Diagnosed on 2026-11-05 by a Claude subagent of the round's lead in its own sdme guest: each check expected behaviour a later change had replaced. Built on `fix/stale-browser-checks`, merged into `v0124/int` as `0226903d7`, with the editor design's lost sentence restored in `8e5bb6124`.

## What was there

- Check 60 collapsed the launcher's "This machine" card through its count badge and read the collapse back after a reload. Since `23a18cd60` (v0.114.0) the counts are a plain `<span class="count-badge">` with no `button.machine-toggle` and no collapse store, so the check could only time out on its first selector.
- Check 125 pressed Ctrl+Shift+P for the Rich Prompt off macOS. Since `a75b8ffe5` (v0.114.0) the chord is Ctrl+Alt+P and Ctrl+Shift+P is the desktop's Toggle Launcher, so the composer never opened. It also ran its own devserver on the fixed port 39147 and killed it 500 ms after SIGTERM.
- Check 134 expected a plain press on rows 8, 9 and 10 (two links and an autolink) to put the caret at the end of the hidden closing tail (119, 149, 178). Since `287286777` (v0.120.0) a plain press puts it at the end of the URL (118, 148, 177). The editor design's sentence stating that rule was dropped by the design rewrite `537a5873d` (v0.122.0).

## Desired contract

1. A check that guards a removed feature goes, when the feature's current shape is pinned elsewhere.
2. A check reads what it presses and expects from the product's own source of truth (the shortcut registry, the document's text), so it cannot stay pinned to a copy of either.
3. A check that runs its own devserver uses the suite's `spawnDevserver`: an ephemeral port, `CHAN_NO_DEVSERVER_HANDOFF=1`, the management token read off the launch URL, and a teardown that waits for the process after SIGTERM.
4. The editor design states where a plain press on an external link, an autolink or a `chan://graph` link puts the caret.

## Boundaries

`scripts/e2e/browser-smoke/checks/60-launcher-collapse.mjs` (removed), `125-mini-window-drafts.mjs`, `134-editor-mark-clicks.mjs`, and one sentence of `web/packages/workspace-app/src/editor/design.md`. No product code.

## Acceptance

1. Check 60 is gone, and the launcher's `Library.test.ts` still pins plain counts ("renders machine and workspace counts as plain text, never as buttons") and a stale collapsed set hiding no card.
2. Check 125 right-clicks the terminal, reads the chord on the menu's Show Rich Prompt row, which renders `chordFor("terminal.richPrompt")`, closes the menu with a press outside it and presses that chord: green, and red with the old chord restored.
3. Check 134 expects the URL's end, computed as the offset of the target's closing `)` or `>`, and presses the last glyph's centre: green, and red on rows 8, 9 and 10 with the old expectation.

## Built

`f25081f52` (drop check 60), `a714bd980` (check 125's chord and devserver), `07ca1f8cb` (check 134's expectation and press), `8e5bb6124` (the editor design's sentence). Verification recorded in the commits: each green alone in an isolated sdme guest at four CPUs and red as acceptance says; checks 90, 125, 134, 176 and 200 to 206 green in one pack in that guest.

Open: Escape does not close the menu in check 125, since the focused terminal takes the key first; the subagent reported it as a product bug, fixed in this release as [escape-does-not-close-a-terminals-right-click-menu](escape-does-not-close-a-terminals-right-click-menu.md). No whole browser suite ran after this merge.
