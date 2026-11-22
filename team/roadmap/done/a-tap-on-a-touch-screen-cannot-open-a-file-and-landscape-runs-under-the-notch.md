# A tap on a touch screen cannot open a file, and landscape runs under the notch

Status: shipped in [v0.133.0](../../release/release-v0.133.0.md), not read on a real phone or in WKWebView: on a touch screen a tap opens a Files row while Details is closed and selects it while Details is open, touch rows are 44px tall and end in a menu button, a double tap into a folder opens nothing, and the fixed chrome stays inside the safe areas, with a mouse unchanged (`v0133/touchopen` at `693d4ac4b`, Murilo Santana's two commits taken in unchanged, merged as `4b08c86a8`; the row file `810de8188`, merged as `e30e87b15`). Read by check 320 with real touch input and emulated safe areas in a Chrome guest, 8 of its 11 legs red at the base, green at the tip and green in the whole browser suite on `49f7491b2`; the last of three readers accepted with notes. Open for the owner: a reading on a real iPhone or the iOS simulator, including the rule that makes a tap on a row's background reach the row in WKWebView, and closing [GitHub issue #9](https://github.com/fiorix/chan/issues/9).

Record before the release: Accepted for v0.133.0 by the owner on 2026-11-21 ("i havent tested on a real ios device but im happy with the local testing simulating a touch device; so long the original behaviour is maintained, im happy... if there is a bug in the new touch code i can report later"). Built and merged into the integration branch. Open for the owner: a reading on a real iPhone or the iOS simulator, and closing GitHub issue #9, which the owner does.

Record: [GitHub issue #9](https://github.com/fiorix/chan/issues/9), reported by Murilo Santana (`mvrilo`) on 0.127.0 in WKWebView, on the iPhone 17 simulator with iOS 26, with a fix on `mvrilo/chan@fix/workspace-touch`. His two commits, `0e7b582c5` and `f79f9258a`, are taken in unchanged, under his name; the commits after them adapt the change to the contract below and add its proof.

## What was there

- A tap on a Files row only selected it. Rows opened on `dblclick`, which a touch screen does not send, and a phone has no room for the Details panel a selection fills, so no file could be opened from the file browser.
- `.app` was `100vh` by `100vw` and nothing padded by `env(safe-area-inset-*)`, so in landscape the app ran under the Dynamic Island and the clock overlapped the tab bar.

## Desired contract

1. A mouse and a trackpad are unchanged: a click selects and a double click opens. The input is read from the press's `pointerType`, so a mouse on a touch laptop keeps this.
2. On touch with Details closed, a tap opens the row: a file in its editor or viewer, a folder entered in a Files tab or toggled in a dock.
3. On touch with Details open, a tap selects and Details shows the row, and in Select multiple it toggles.
4. A tap within 400 ms of one that entered a folder opens nothing, and neither does the double click a browser can make of two taps, because the second tap would land on whatever row the folder put under the finger.
5. Where the primary pointer is coarse and cannot hover, rows are 44px tall and end in a button that opens the existing row menu.
6. The window, its tab bar, the status pill, overlays and menus stay inside the safe areas.

## Boundaries

- The web client only: no server, desktop or wire change.
- No new row actions: the touch button opens the menu a right click opens.
- A long press is not relied on, since it does not reliably send `contextmenu` on a touch screen.

## Acceptance

1. Check `scripts/e2e/browser-smoke/checks/320-files-touch.mjs`, with real touch input and emulated safe areas in Chrome: red at the base on the touch legs, green at the tip, with its mouse legs green at both.
2. The mounted cases in `FileTree.touchOpen.test.ts`.
3. The checks that drive the file browser, its menus and the fixed chrome hold on the merged tree.
4. For the owner, not run here: a tap on a file name and on a row's empty area, then a turn to landscape, on a real iPhone or the iOS simulator. The rule that makes a tap on a row's background reach the row in WKWebView is unproven.

## Built, 2026-11-21

A tap opens a row while Details is closed and selects it while Details is open, touch rows are 44px tall and end in a menu button, a double tap into a folder opens nothing, and the fixed chrome stays inside the safe areas. The input is read per press, so a mouse keeps select and double click. The change is in `FileTree.svelte`, `menuClamp.ts` and the components of the window's fixed chrome, and the workspace app's design notes and the manual's Files page describe it.

Evidence, in the development tree:

- Check 320 at `693d4ac4b`, in a Chrome guest with real touch input and emulated safe areas: at the base `53b98632d`, 8 of its 11 legs red, with the mouse, Details and Select multiple legs green; at the tip green in three runs alone and once beside 163, 170, 177, 206, 210, 20 and 21.
- On the merge `4b08c86a8`: `make web-check`, `make web-marketing-check`, `make e2e-check` and `make shell-check` green, and check 320 green alone and in one runner call of 54 checks over the file browser, its menus and the fixed chrome. 51 passed. Check 122 failed only for its example binary and is green once that is built, before and after the merge. Checks 234 and 251 fail the same way before and after the merge, so neither comes from this change.
- Three readers; the last accepted with notes.
- Not read: WKWebView or a real phone. Chrome's touch and safe-area emulation stands in for them, and the rule that makes a tap on a row's background reach the row in WKWebView is unproven.
