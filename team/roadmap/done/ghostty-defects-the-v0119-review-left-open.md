# Ghostty defects the v0.119.0 review left open

Status: shipped in [v0.120.0](../../release/release-v0.120.0.md).

Record before the release: the terminal findings are implemented on their lane, with every finding's outcome recorded below; finding 3 landed on its separate lane (`805eab91f`); the native platform readings (the macOS checks and the Windows readings for findings 7 and 9) were not received by the GA cut and are recorded as pending in the release report.

## What was asked

Three reviewers read the ghostty work of v0.119.0 (the libghostty-vt binding, the key path, and the terminal tab with the launcher change) and tried to break it. Their should-fix findings were fixed before the GA: AltGr and dead-key characters lost on Linux and Windows, a layout's ASCII Option characters on macOS, the core's replies to color queries, a grapheme read past its scratch area, rows left in the old default colors, and a tmux card that failed to render before its session was named. What follows is what they found and judged minor, each with its trigger and the evidence they left. The probes are in the round's `dev/v0119-ga/review/` tree, mirrored to the archive at the round's close.

## Open findings

1. Focus is reported twice on a resume in Chromium and WebView2. The resume repair blurs and refocuses the terminal host; Chrome dispatches the window `focus`, then the repair runs, then the `focusin` it kept, so a program with focus reporting (mode 1004) sees CSI O, CSI O, CSI I, CSI I on every return, and one more pair on a browser tab switch, where `visibilitychange` and `focus` both run it. The final state is right. Measured with headful Chrome under Xvfb (`c/focusprobe/probe.mjs`); WebKit not measured. Candidate fix: skip a focus report that repeats the last one sent (`onGhosttyFocusChange`).
2. The core's kitty keyboard flags can disagree with chan's copy. After a reconnect whose replay was cut, `TerminalTab` writes RIS and restores only chan's copy, so the core answers `CSI ? u` with 0 while chan encodes with the program's flags; DECSTR resets chan's copy but not the core's; ten pushes and nine pops leave the two at different depths; and the core refuses flags above 31 that chan stores. `workspace-app/src/design.md` says the core answers the query from its own copy of the same state, which these cases contradict. Evidence: `c/review-c-osc.scratch.test.ts` (the replay-cut case) and `b/review.vtReplies.test.ts` (the `agree` case). Candidate fix: re-apply the restored flags to the core after the RIS, or answer `CSI ? u` from chan's copy and drop the core's reply.
3. The command launcher can give one machine two names. A plain window's machine is the first devserver row in feed order (`machineNameForLibrary`), a tmux window's the first by name (`tmuxHost`), so with a direct row and its gateway roster row on one library a plain window reads `zeta` and that machine's tmux window `tmux -CC on beta (main)`. A devserver row that resolves to this machine's own library also makes a local run read `tmux -CC on <that row>`. Evidence: `c/review-c-launcher.scratch.test.ts`, `c/review-c-tmuxHost.scratch.test.ts`. Candidate fix: one by-name lookup for both.
4. The core answers XTVERSION (`CSI > q`) with `libghostty`, which xterm.js does not answer and ghostty-web's build did not. Decide whether chan's terminals identify themselves there.
5. Text the browser types reaches no ghostty terminal while its host holds the focus. ghostty-web cancels a `beforeinput` aimed at the host, which chan focuses, and reads `beforeinput` only on its hidden textarea, so text with no keydown of its own (Alt+Numpad on Windows, an Option character with no key code mapping, the macOS emoji picker, dictation, an input method's commit that does not compose) is dropped; already so in v0.118.0. The probe's `inserttext` mode shows an emoji sent by xterm.js and by ghostty with the textarea focused, and not with the host focused (`b/review-probe/run.mjs`). Candidate fix: forward an `insertText` that lands on the host, or focus ghostty-web's textarea.
6. A dead key followed by a key that types no text (Enter, Tab) loses that key; xterm.js sends it from its keypress handler.
7. The key after a Windows dead key types `ev.key`, as ghostty-web's own keydown did in v0.118.0. That is right only if Windows Chromium (Chrome and WebView2), which sends no composition events for a dead key, puts the composed character in `key`; if it puts the base key, a dead acute then e types `e`. Either way US-International's apostrophe before a consonant or a space is lost, since one `key` cannot hold `'t` (`b/review-probe/run.mjs deadfail`, Windows events modelled in Chrome). Settle it on Windows with the W3C key event viewer: type `'` then `e` and read the second keydown's `key`. Candidate fix: keep a key after `Dead` with the browser and forward the host's `insertText`, as in 5.
8. On a US Mac layout Option+Shift+` is a backquote, so the Option rule types it where xterm.js sends ESC ~.
9. On Windows, Ctrl+Alt+letter with no AltGr character types the bare letter (an Emacs C-M- chord types a stray letter), and an AltGr+V character (`@` on Czech, Slovak and Hungarian layouts) is dropped by ghostty-web's paste early return. Both were already so in v0.118.0.
10. One cell can keep a stale spacer head. Writing 79 `x` and then U+1F468 (a wide character) on an 80-column row, rendering, then `\ra`: the core clears row 0's spacer head without marking the row dirty, so the binding keeps width 0 and one cell's background goes unpainted. One failing seed in 3,000 of a fuzz (`a/ghosttyVt.review.test.ts`, F20 and F24). Candidate fix: report upstream; optionally re-read the row above a dirty row.
11. A failed allocation of the write buffer leaves it dangling: the old buffer is freed and the capacity set before the allocation throws, so the next write lands in freed memory and a later free frees it twice. Shown with a simulated out-of-memory (F8). Candidate fix: allocate first, then free and swap.
12. The vendored wasm uses wasm SIMD (13,024 simd128 instructions by a code-section census, `a/opscan.mjs`; ghostty-web's build has none). A WebKit older than 16.4, as on a macOS 11 or 12 machine that never updated Safari, would fail to compile it and fall back to xterm.js for every terminal, fetching and compiling 1.2 MB again at each spawn because a failed load is not cached. Inferred from the census, not run on such a machine.
13. History reads go cell by cell through grid references, about four wasm calls a cell: one screen of history at 120x40 reads in 1 to 1.6 ms, and Copy scrollback of 55,000 lines blocks the page for 1.7 s at 120 columns and 3.5 s at 200, three to six times ghostty-web's build per row, measured in Node by the review's probes (`a/ghosttyVt.review.test.ts`).
14. A cluster longer than 32 codepoints shows 32 on screen and only its base letter in history: the history read passes the core a 32-codepoint buffer, gets OUT_OF_SPACE and gives up, where the hyperlink read retries with the length returned.
15. In-band resize reports (mode 2048, which the core now advertises) leave only at the next PTY output, since ghostty-web drains replies after a write, and carry zero pixel sizes, since the binding gives the core none.
16. ghostty-web's own wasm still ships, inline as base64 in its lazy chunk (565,252 of the chunk's 648,960 bytes; never instantiated). Candidate fix: alias the module's data URL away in the build.

## Triage

The lead's recommendation, one outcome per finding, and the owner's word on 2026-10-31: "i take your recommendations about the ghostty findings; including the call to drop libghostty reply".

Fix in v0.120.0, with the fix chosen where the finding offers more than one:

- 1: skip a focus report that repeats the last one sent.
- 2: answer `CSI ? u` from chan's copy of the kitty keyboard flags and drop the core's reply, so one copy decides; `workspace-app/src/design.md` says so.
- 3: one by-name machine lookup for plain and tmux windows.
- 4: drop the core's XTVERSION reply, as the color replies are dropped, so a ghostty terminal answers as an xterm.js terminal does.
- 5: forward an `insertText` that lands on the host to the terminal.
- 6: send the key after a dead key when it types no text, as xterm.js does.
- 7: read the second keydown's `key` on Windows first (the W3C key event viewer, `'` then `e`), then fix with 5.
- 9: both cases, Ctrl+Alt+letter with no AltGr character and the AltGr+V character, read on Windows before and after.
- 11: allocate the new write buffer first, then free and swap.
- 12: remember a compile failure of the wasm for the page's life, so a WebKit without wasm SIMD falls back to xterm.js once; a fetch failure still retries. No build without SIMD.
- 14: retry the history read with the length the core returns, as the hyperlink read does.
- 15: drain the core's replies after a resize, and give the core the cell's pixel size.
- 16: alias ghostty-web's inline wasm data URL away in the build.

Close here:

- 8: it is the owner's v0.119.0 rule ("ASCII types itself"): on a US Mac layout Option+Shift+` gives a backquote, printable ASCII, which types itself.
- 10: a defect in the Ghostty core, rare (one seed in 3,000) and cosmetic; it is for an upstream report, not a workaround here.

Deferred:

- 13: a speed item that needs its own measurement; at the v0.120.0 close it moves to the next active version as an item of its own.

## Acceptance

Each finding to fix is fixed with a test or a build check that was red before it; 7 and 9 also carry the Windows reading before and after. 8 and 10 close here with the reasons above, and 13 moves on as above.

## Outcomes, 2026-11-01

1. Fixed in `0b7086ec0`: focus reporting skips a repeated state. The automated Chrome reading observes exactly CSI O then CSI I through a tab switch and back, with matching `cat -v` output (`dev/v0120-team/evidence/Term120/stage2-focus-live.json`); native WebView behaviour is not measured.
2. Fixed in `0b7086ec0`: chan answers `CSI ? u` from the flags its encoder uses, and drops the core's answer. Tests cover cut replay, DECSTR, stack depth, flags above 31, alternate-screen restore and byte-split queries; the terminal design describes the same authority.
3. Fixed in `805eab91f` on its separate lane (`v0120/machname`): one by-name claim rule (`devserverForLibrary`) names plain windows, tmux windows and workspace targets of a library by the same devserver row, the local card claiming its own library first; a devserver row that resolves to this machine's library leaves a local tmux run on This machine.
4. Fixed in `0b7086ec0`: the binding drops the core's XTVERSION reply, while DSR and DA replies still pass.
5. Fixed in `7ef78f7d9`: host `insertText` sends browser text once through the user-input path, with composition and textarea input owned by ghostty-web. Before/after Chrome readings show an emoji reaching the PTY once only with the fix (`dev/v0120-team/evidence/Term120/stage3-input-before.json` and `stage3-input-after.json`); the native macOS emoji picker and dictation readings remain pending.
6. Fixed in `7ef78f7d9`: a non-text key after Dead sends its encoded bytes, including CR and HT. The installed xterm.js measurement does not establish the finding's "as xterm.js does" premise: with synthetic Dead then Enter or Tab, its keydown cancels the key before the pending-dead-key return, and no keypress or bytes follow, while ordinary Enter and Tab controls pass (`dev/v0120-team/evidence/Term120/stage3-xterm-reading.json`). A native dead-key source is not traced; the explicit non-text-key contract is implemented.
7. Fixed in `57d6fc512`: on Windows, a printable key after Dead stays with the browser so host `insertText` supplies either the composed character or apostrophe-plus-letter text once. The tests and Chrome probe model the next `key` as the base key and as composed text, including apostrophe then consonant or space (`dev/v0120-team/evidence/Term120/stage4-windows-before.json` and `stage4-windows-after.json`). Not verified on Windows: the W3C key event viewer reading of apostrophe then e, including the second keydown's `key`, remains open for a Windows machine.
8. Closed: the owner's printable-ASCII Option rule makes Option+Shift+backquote type the backquote on a US Mac layout.
9. Fixed in `57d6fc512`: Windows Ctrl+Alt plus a bare ASCII letter sends its control-Meta encoding; a layout character types itself, and AltGr+V bypasses ghostty-web's paste early return. Ctrl+V remains 0x16 on Linux and Windows, where Ctrl+Shift+V retains native paste; macOS uses Cmd+V. Modeled Windows events are exercised in tests and Chrome; native Windows before/after readings remain unverified.
10. Closed as a rare cosmetic defect in the Ghostty core, without a chan workaround. The upstream report is drafted for the owner at `dev/v0120-team/reports/drafts/ghostty-finding-10-upstream.md`; it is not filed.
11. Fixed in `eee284c03`: write-buffer growth allocates before freeing or swapping, so allocation failure leaves the live buffer usable and freed exactly once later. The injected failure test covers recovery and subsequent growth.
12. Fixed in `eee284c03`: wasm compile failure stays cached for the page's life, while failed fetches retry. Compile-rejection and fetch-retry tests pass; the behaviour on an old WebKit without SIMD is not measured on such a machine.
13. Deferred to the next version as a separate performance item, with its own measurements required; the row's close moves it to v0.121.0.
14. Fixed in `eee284c03`: history retries an out-of-space grapheme read using the returned length, and screen rendering reads the whole cluster. Tests preserve a base letter plus 33 combining marks on screen and in history, its width and the following cell.
15. Fixed in `0b7086ec0`: a resize supplies current cell pixel dimensions and drains the core's reply immediately through the generated-input path. Tests cover both the binding and its kit/component wiring.
16. Fixed in `eee284c03`: the build removes ghostty-web's unused inline wasm data URL. The lazy chunk measures 648,962 bytes before and 83,687 after, a 565,275-byte reduction; the vendored wasm remains 1,191,241 bytes and is byte-identical. The build test fails if the inline wasm returns or the vendored asset changes.
