# ghostty sends a pasted line break as LF where xterm.js sends CR

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

Origin: drafted on 2026-11-11 from the v0.128.0 basic-flows browser check 216 and its probe, for the owner to accept, move or drop. Not started.

## What is there now

A text with a line break pasted into a chan terminal by Ctrl+Shift+V or by the menu's Paste row reaches the PTY differently on the two engines. xterm.js rewrites `\r?\n` to `\r` before sending (`prepareTextForTerminal`, on both paths, `term.paste` included); ghostty-web (`emitPasteData`, `Terminal.paste`) sends the text unchanged, so the PTY reads `\n`. Under bracketed paste (check 216 asserts this form) a program that brackets handles either. Without bracketed paste (probe 916, `dev/v0128-team/evidence/Term128/basicflows-2/probes.log`), a raw-mode program reads Enter per pasted line under xterm.js and Ctrl+J under ghostty: a shell's line editor sees a different key. What native Ghostty sends for a pasted newline was not read; terminal convention (and xterm.js) is CR.

## Desired contract

1. A pasted line break reaches the PTY the same way on both engines, as CR unless native Ghostty is found to send LF, in which case the row records that and keeps ghostty-web as it is.

## Boundaries

- ghostty-web's paste path in `web/packages/ghostty-web` (or `ghostty-web-ng` once forked); xterm.js and the bracketed-paste form are the reference.

## Acceptance

1. Check 216 extended with an unbracketed leg (probe 916's form) asserting the same bytes on both engines, green at the tip and red on the current ghostty-web.
2. The native Ghostty reading recorded in the row (its source or a run).
