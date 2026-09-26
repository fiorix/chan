# The memfd ring mirror doubles a terminal's memory and costs peak write throughput

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by the terminal restore order of team v0101 that built the ring file (`dev/v0101-team/reports/report-Runtime-1.md`, "Cost", corrected by `reviews/review-Runtime-1.md` finding 8, in the development tree). Measured in chan-v098 under the fixed user unit.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: the 64 KiB reader buffer is this version's remedy for the throughput cost (one ring push and one mirror write per read instead of eight), measured before and after by the order that makes it; the mmap-backed ring is named as not taken, and the memory cost stands as measured.

## What was seen

The ring file that carries a terminal's whole ring across a restart mirrors every push into a memfd beside the in-process ring, so a full terminal costs about 2 MiB of heap and about 2 MiB of shared memory charged to the unit's memory cgroup (200 MiB of shmem at 100 full terminals, resident across restarts because the store holds the files), and one terminal writing flat out drains at about 78 MiB/s where it drained at about 92 MiB/s (14.7% lower), because each 8 KiB read costs three or four `pwrite` calls. Restore costs about 4.5 ms per full ring. The owner accepted the ring with the cost measured; the mirror was the shape that fit one order.

## Desired contract

A terminal's ring is held once, and the ring file costs a session no measurable write throughput.

## What to do

Two shapes, in order of size. A 64 KiB reader buffer cuts the syscall count eightfold with a small change; measure the drain again. Mapping the memfd as the ring itself removes the second copy and the syscalls, but `RingBuffer` is a chunk deque and chan-library forbids `unsafe`, so it needs a mapping crate (a `Cargo.lock` change with the Nix hash) or a different ring shape; the owner decides whether that is v0.101.0 work. The manifest tail for ring entries is a separate cost handled by the crash resume order.

## Boundaries

`crates/chan-library/src/terminal_sessions/ring.rs` and the reader in `terminal_sessions.rs`; the measurement driver under `dev/v0101-team/evidence/Runtime/r1-measure.sh` is the baseline.
