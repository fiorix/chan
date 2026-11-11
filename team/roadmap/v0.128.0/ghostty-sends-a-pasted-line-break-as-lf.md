# ghostty sends a pasted line break as LF where xterm.js sends CR

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Built the same day with the ghostty copy row's cleaned paste (see Built).

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

## Built, 2026-11-11

Built on 2026-11-11 with the gcopy row's cleaned paste on `v0128/gcopy` (`ce2eba512`, check 216 in `15b57cf47`). The native Ghostty reading (acceptance 2) comes from Ghostty's source at the tag libghostty-vt 1.0.0 is cut from (`vt-1.0.0`, commit `0fa3d577a5614150ff8e2c152de5fb9d5c6d2dec`): `src/input/paste.zig` (`encode`), used for every text paste by `src/terminal/paste.zig` and exported as `ghostty_paste_encode` (`include/ghostty/vt/paste.h`). Under bracketed paste native Ghostty frames the text and leaves its line ends as they are, LF as LF and CRLF as CRLF; without bracketed paste it turns each `\n` into `\r`, so CRLF becomes CR CR; in both modes it replaces NUL, BS, ENQ, EOT, ESC, DEL and ten tty control characters with spaces. It sends CR for an unbracketed LF, the case this row was raised for, and LF only inside a bracket. chan converts every LF and CRLF to CR in both modes on both engines, because the gcopy row's contract 4 pins xterm.js's conversion; the exception clause of contract 1 was not taken, since native Ghostty's LF is bracketed only, where a program that brackets takes either byte. Check 216 now expects CR on ghostty as on xterm.js and pastes on both engines once more into a recorder that did not ask for bracketed paste, with an LF and a CRLF in the text: the same bare bytes on both engines, green at the tip ten runs in a row and red on the base, whose ghostty legs sent LF bracketed and unbracketed (acceptance 1).
