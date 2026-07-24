# Rework the devserver startup-journal branch (fdstore boot mounts)

Status: REGISTERED for v0.77.0. Branch
`claude/dev-server-startup-journal-jrl3rw` (a42436ac) was reviewed
adversarially (20 verified findings): real idea, wrong disease for
the rebuild-storm incident, and unsafe to merge as-is. This item is
the rework, not a re-review.

## Why not as-is (verified findings, review record)

- Pending re-mount rows are invisible to `persist_state`: any
  mid-window persist DROPS them from the overlay, and a crash then
  loses the user's on-set.
- Toggle-off / forget during the background-mount window are
  silently reversed when the mount completes.
- READY fires with mounts pending, turning fail-visible into
  fail-silent on slow trees.
- The deferred fdstore apply can duplicate restored terminals after
  clients reconnect.
- The restore task is detached: no owner, no cancellation on
  shutdown.

## Rework shape

- Track pending rows as `starting` in the serving map BEFORE the
  spawn (fixes persist visibility and the toggle races).
- Supervise the restore task: an owner plus shutdown-aware
  cancellation.
- Keep the fdstore apply ahead of serving terminals; READY only once
  mounts are settled (or keep failures visible).
- chan-desktop already backgrounds boot mounts, so this branch never
  affected desktop startup; the desktop gate is lever 5
  (workspace-open-reconcile-off-mount-path.md).

## Acceptance

- The five findings each carry a regression test; the fdstore restart
  e2e (chan-systemd CHAN_SYSTEMD_FDSTORE_E2E) stays green.
- Startup journal covers the slow-mount window honestly (states
  visible, READY late, no reversal of user intent mid-window).
