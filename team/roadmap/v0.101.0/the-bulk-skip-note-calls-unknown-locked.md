# The bulk-skip note calls an unknown row locked

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the Lead follow-ups ledger (2026-09-22 23:56Z, SecondWorker order 5 report). A source reading against `main` at `6237c2677`.

## What was seen

A bulk action skips rows whose lock state could not be read as well as locked rows, and the note counts both as locked: `selection.svelte.ts` builds `"N locked workspace(s) skipped"` for every skipped row (`web/packages/launcher/src/state/selection.svelte.ts:180`), and `selection.svelte.test.ts:149` pins that wording for every skipped status, `unknown` included.

## What to do

Word the note by what was skipped, for example counting unknown rows separately, and update the test's table to expect the distinct wording.
