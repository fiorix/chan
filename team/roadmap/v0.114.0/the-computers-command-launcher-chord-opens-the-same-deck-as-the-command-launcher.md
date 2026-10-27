# The Computers command launcher chord opens the same deck as the command launcher

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; decided, not built.

## What was asked

Found while rewriting the manual's Computers screen pages on 2026-10-27; the owner asked for it to be saved for later.

## Evidence

Read at `0119a1912`. `web/packages/workspace-app/src/state/shortcuts.ts` registers `app.launcher.computers`, "Computers command launcher", Cmd+Shift+K on macOS and Ctrl+Alt+Shift+K on the Linux and Windows desktop, desktop only. App.svelte dispatches it to `showCommandLauncher("computers")`, which ignores its argument and toggles the same deck as Cmd+K / Ctrl+Alt+K (around line 208), so the chord opens the contextual list, not the Computers scope. The manual does not document the chord.

## Owner decision (2026-10-27)

"just cmd+k enough, no need to have the cmd+shift+k vriant".

## What to do

Remove `app.launcher.computers`: its registry row and `COMPUTERS_LAUNCHER_ID` branch in `shortcuts.ts`, its dispatch in `App.svelte`, the launcher package's twin binding in `web/packages/launcher/src/components/CommandLauncher.svelte` (the "computers" entry mode), and the tests that pin it. Cmd+K / Ctrl+Alt+K and the deck's Computers scope stay.

## Acceptance

- Settings > Keyboard Shortcuts no longer lists Computers command launcher; Cmd+Shift+K and Ctrl+Alt+Shift+K do nothing in Chan Desktop and the launcher.
- workspace-app and launcher vitest and svelte-check green.

## Build findings and evidence (2026-10-27)

Built on `572c3692c`.

Change: `app.launcher.computers` is gone from `SHORTCUTS`, with its `COMPUTERS_LAUNCHER_ID` branch in `osChord`, so Settings > Keyboard Shortcuts and the shortcut table list only Command launcher (Cmd+K on the macOS desktop, Ctrl+Alt+K elsewhere). `App.svelte` drops the override branch and the `chan:command` case for the id and calls `toggleCommandLauncher()` directly in place of the `showCommandLauncher(mode)` wrapper, whose mode argument nothing read. The launcher's `onWindowKey` drops the Shift chord. With it gone the launcher's "computers" entry mode had no caller outside tests, so the launcher state keeps one draft (`commandLauncher.draft`) and the shared deck model drops `DeckEntryMode`: `createDeckDraft()` and `loadSessionDeckDraft(key)` take no mode and `SESSION_DECK_DRAFT_KEY` replaces `sessionDeckDraftKey(mode)`, keeping the `chan.command-launcher.v1:contextual` key so drafts in open tabs survive a reload. The Close-count keys drop their entry-mode prefix. `web/packages/launcher/design.md` and the `key_bridge.js` comment name one launcher chord; no Rust test reads that comment.

Finding: before the change the workspace app never opened the deck on a Cmd+Shift+K keydown; the id fired only from a `chan:command` host command (nothing sends one) or a user override. Its `escapeTerminal: true` row did take Cmd+Shift+K / Ctrl+Alt+Shift+K away from a focused terminal. The launcher page did open its deck on the Shift chord.

Stored overrides: an override saved for `app.launcher.computers` still hydrates (hydration keeps any id, since extension commands are not known at load) and raises nothing; pressing its chord fires nothing and the key falls through to the built-in keymap. It still makes that chord escape a focused terminal, the same as an override for any other unregistered id.

Tests added: `web/packages/workspace-app/src/App.commandLauncherChord.test.ts` (macOS and Linux desktop: the Shift chord does not open the deck while the plain chord does, the Shift chord reaches a focused terminal, a host command for the old id opens nothing, a saved override for the old id is ignored, the table lists one launcher chord on every platform) and two cases in `web/packages/launcher/src/components/CommandLauncher.test.ts` (macOS Cmd+Shift+K and Linux Ctrl+Alt+Shift+K on the desktop leave the deck closed and unclaimed; the plain chord opens it with no scope). The launcher test that kept Close counts apart between contextual and Computers drafts is removed with the mode; the other launcher tests open the single draft.

Red first, with the new tests run against the `572c3692c` sources: workspace-app 7 of 9 failed at the intended assertions (terminal escape `true`, host command and override opened the deck, `SHORTCUTS` still held the id); the two Shift-keydown cases passed there, matching the finding above. Launcher 2 of 2 failed at `defaultPrevented` (the Shift chord was claimed).

Green, run in each package directory:

- workspace-app `timeout 1200 npx vitest run`: 604 files, 7849 tests passed. `timeout 600 npx svelte-check --tsconfig ./tsconfig.json`: 0 errors, 0 warnings.
- launcher `timeout 1200 npx vitest run`: 65 files, 703 tests passed. svelte-check: 0 errors, 0 warnings.
- web-shared `npx vitest run`: 8 files, 234 tests passed. svelte-check: 0 errors.

Left open: `docs/adr/0001-desktop-owns-aggregate-launcher-authority.md` still says the launcher has contextual and Computers entry modes and keys drafts by entry mode; it is a decision record, so it is left for the owner to amend or supersede. Not run: the Rust suites, the browser suite, and a real Chan Desktop press of the removed chords.
