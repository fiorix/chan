# The fd-store manifest reads the sequence apart from its replay tail

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the Lead follow-ups ledger (2026-09-22 20:52Z, SecondWorker order 1 report, by reading); the Rust-lows fold-along did not assess it. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 with the lead's shape, which settles the first question under What to do: read `seq` and the replay tail under the ring lock, with an interleaving test shown red first, rather than proving the reader cannot run. The owner added a requirement: check that terminal replay works end to end, including after two devserver restarts. The symptom the owner has seen is a non-focused terminal tab that, some time after a devserver restart, prints errors about something disagreeing and then the prompt.

## What was seen

`Session::fdstore_manifest_entry` (`crates/chan-library/src/terminal_sessions.rs:3838`) records `seq` with a relaxed load of `self.seq` (`:3879`) and then takes the replay tail from `fdstore_replay_tail` (`:4082`, `:3887`), which snapshots the ring under its own lock. A PTY read that lands between the two leaves a manifest whose sequence and tail disagree, the same split read the attach fix closed by reading `seq` under the ring lock (7d2c80a41). This path runs when a session is parked for a restart handoff; whether a PTY read can still arrive there is not established.

## What to do

Establish whether the reader can run during the manifest build. If it can, read `seq` and the tail under the ring lock the attach path uses, with a test that interleaves a write between the two reads and is shown red first; if it cannot, say why in a comment beside the two reads.
