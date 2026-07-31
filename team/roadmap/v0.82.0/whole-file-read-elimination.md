# Eliminate the whole-file read class

Status: REGISTERED for v0.82.0; grounded 2026-07-31 while scoping large-transfer support.

## What

Most of the server streams. Four paths do not, and each of them loads an entire file into one allocation before answering. Peak resident memory on those paths is the size of the file, so the ceiling is whatever the machine has, and the failure is an OOM rather than a refusal.

`Workspace::read` is the primitive: `Vec::new()` followed by `read_to_end`, with no size cap and no chunking. Because cap-std forwards `read_to_end` straight to `std::fs::File`, the standard library takes the size-hint path and reserves the whole file in a single allocation.

Four callers reach it:

- The `Image | Pdf` arm of the file read, so a large PNG or PDF is read whole.
- The `NotEditableText` fallback, which catches every binary that is not `mp4`, `webm`, `mov`, or `mp3`. A zip, iso, tar, or unknown extension is read whole on a plain GET.
- Every member of a workspace directory download, where the bytes are held in a cursor for the whole tar member. A folder holding one very large file is a single allocation of that size.
- `Workspace::copy`, which reads the source whole and then writes it with a sink limit of `u64::MAX`. This path has no size gate of any kind.

The plain text read has the same shape: `read_text` loads the file into a `String`, so a large `.md` or `.txt` is read whole. The chunked variant already exists and is used by the streaming read.

None of this requires an unusual request. Clicking a file in the inspector reaches the first two.

## The indexer holds the write lock while it does it

`Workspace::index_file` takes the per-workspace write serialization lock and then calls `read_text`, with no size check. Indexing is gated to `.md` and `.txt`, so a single large text file landing in a watched workspace both allocates its full size and holds the lock that reconcile and rename need. The result is not only memory pressure: it is a workspace-wide stall on a path unrelated to the file being indexed.

This is the same defect class and it is a prerequisite for raising any write ceiling, so it belongs here rather than with the capability work.

## Boundary

This item removes a memory hazard that exists today at today's limits. It does not raise any write limit, add concurrency control, or change how transfers are scheduled. Those are the capability half and are tracked separately for v0.83.0, sequenced after an admission mechanism exists. Nothing here depends on that work, and shipping it first is what makes the machine safe at the sizes users already reach.

## Contract

- No HTTP read path holds a whole file in memory. Reads are bounded and chunked regardless of file class or extension.
- Binaries that are not currently range-served are served through the same bounded reader that already backs the download path, so byte-range support is uniform across binary types rather than limited to four media extensions.
- Directory download writes each member from a bounded reader with the size taken from its stat, rather than materializing the member first.
- `Workspace::copy` streams through the atomic sink and carries a real budget instead of `u64::MAX`.
- The indexer stats a file and declines to index it above a threshold, before reading it and before taking the write lock. Declining to index is not an error; the file remains readable and editable.
- The size at which a file becomes too large to index and the size at which it becomes too large to open in the editor are one server-reported value, so the SPA renders one consistent explanation rather than two thresholds that disagree.
- `?download=1` advertises `Accept-Ranges` and a strong validator, so a client that loses a large download can resume it rather than restart. This rides here because it reuses the bounded slice reader that already clamps correctly; upload resume is not in scope.

## Known adjacent defect

`Content-Length` on the download path is stamped from the stat taken when the file is opened, while the producer loops to EOF. A file whose size changes mid-transfer therefore sends a body that disagrees with its declared length. The window is milliseconds today and grows with file size. Fix it here while the path is open.

## Acceptance

- A plain GET of a multi-gigabyte binary with no recognized extension holds resident memory flat rather than proportional to the file.
- A plain GET of a large PNG or PDF holds resident memory flat.
- A directory download containing one very large member holds resident memory flat.
- A file-browser copy of a very large file holds resident memory flat and refuses above its budget rather than proceeding unbounded.
- Indexing declines above the threshold without taking the write lock, and a rename or reconcile issued while a large file is being considered for indexing is not delayed by it.
- `?download=1` answers a range request correctly at the first byte, the last byte, and across the end of the file, and its validator changes when the file changes.
- A transfer whose file is truncated mid-flight does not send a body that disagrees with its declared `Content-Length`.
- The existing binary-transfer browser smoke is extended from its current fixture to a multi-gigabyte file, and asserts process thread count and open file descriptors alongside resident memory. Thread exhaustion is the ceiling that arrives before memory does, and nothing pins it today.

## Rough size

Medium. Each change is local and the bounded reader already exists, so most of the work is routing existing callers through it. The indexer gate and the range support on the download path are the two pieces that are genuinely new.
