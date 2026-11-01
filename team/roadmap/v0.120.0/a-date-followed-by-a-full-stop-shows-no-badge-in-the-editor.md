# A date followed by a full stop shows no badge in the editor

Status: raised and accepted for v0.120.0 by the owner on 2026-10-31, during the v0.119.0 cut ("another roadmap item"); cause found by reading and confirmed by a probe, not started.

## What was asked

The owner's words, 2026-10-31: "on the editor, we render dates based on a set of formats that we support and are configurable... earlier this week i realised on documents where the date is at the end of a sentence, and is followed by a period, the date badge does not render. e.g. 'Happening on Halloween, 2026-10-31.'"

## What is there now

Read at `e721c63bf`, the v0.119.0 GA commit. The editor finds dates with `findDateMatches` (`web/packages/workspace-app/src/editor/dateFormats.ts`), which the date badge widget (`editor/widgets/date.ts`) and the date macros (`editor/commands/date_macros.ts`) both call. Each catalog format's scan pattern sits between two boundaries built from `SENTINEL_BAD = "A-Za-z0-9./\\-"`: the character before a date and the one after it must not be a letter, a digit, a dot, a slash or a dash, so that a date inside a longer token stays plain. The dot is in that set to keep a file name such as `/path/04/05/2024.txt` from getting a badge, and it also refuses a full stop that ends a sentence.

A probe of `findDateMatches` at that commit:

| Line | Matches |
| --- | --- |
| `Happening on Halloween, 2026-10-31.` | none |
| `Happening on Halloween, 2026-10-31` | `2026-10-31` |
| `Happening on Halloween, 2026-10-31, at noon` | `2026-10-31` |
| `Happening on October 31, 2026.` | none |
| `Happening on 31 Oct 2026.` | none |
| `Happening on 31/10/2026.` | none |
| `Due 2026-10-31.` and a newline | none |
| `(2026-10-31).` | `2026-10-31` |
| `On 2026-10-31... maybe` | none |
| `See notes/2026-10-31.md for more` | none |
| `Version 2026-10-31.1 shipped` | none |

Every format misses a date before a full stop; a comma or a closing parenthesis passes. The last two rows are dates inside longer tokens, which should stay plain. `dateFormats.test.ts` pins `v2026-05-05`, `2026-05-05x`, `build-2026-05-05-rc1` and `/path/04/05/2024.txt` as no dates.

## Desired contract

1. A date in any catalog format followed by a full stop that ends a sentence gets its badge: one or more dots followed by the end of the line, whitespace, or closing punctuation (`)`, `]`, a quote).
2. A dot followed by a letter or a digit still continues the token: `notes/2026-10-31.md` and `2026-10-31.1` stay plain, as do the token cases the tests pin today.
3. The boundary before a date is unchanged, and the date macros see the same dates the badges show.

## Acceptance

1. `dateFormats.test.ts` pins the owner's sentence and one line per catalog format ending in a full stop as matches, a full stop at the end of a line and before closing punctuation, and an ellipsis before a space; and keeps `notes/2026-10-31.md`, `2026-10-31.1` and the four token cases unmatched. The new matching cases are red before the fix.
2. The date widget shows a badge on `Happening on Halloween, 2026-10-31.` in the editor.

## Closing evidence - 2026-11-01

`dateFormats.ts` accepts a trailing run of dots when the run reaches whitespace, line end or `)`, `]` or a quote; its leading boundary and the letter, digit, slash and dash exclusions stay in place. The date widget and the date-at-caret macro both call `findDateMatches`, so they read the same matches.

`dateFormats.test.ts` covers the owner's sentence, all seven catalog formats before a full stop, a dot run at line end or before whitespace, each closing punctuation, and the longer-token exclusions. The new matching assertions were red before the change (14 failed, 20 passed); the focused test passes all 36 cases with the change. Four isolated mutations of the dot-run, line-end, closing-punctuation and letter-or-digit guards each failed the corresponding cases.

After `make web`, an isolated Chrome check opened `ws-alpha/datestop.md`, reloaded with cache disabled and found a visible ISO date badge for `2026-10-31` in `Happening on Halloween, 2026-10-31.`. The screenshot and driver log are in `dev/v0120-team/evidence/Editor120/`.
