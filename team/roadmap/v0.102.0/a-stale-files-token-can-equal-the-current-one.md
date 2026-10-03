# A standalone Files write is not shown to be refused when a change kept the file's mtime token

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the limit that the lead's acceptance of a test-only order names and that no item held (`dev/v0101-team/machine-move/lead30-services45-acceptance.md` in the development tree; `dev/v0101-team/reports/report-Services-45.md`, its last paragraph; `dev/v0101-team/machine-move/lead38-recon-10-residuals-release.md`, "Residuals the team can close under existing authority"). The lead read the production path at `main` `e07f3862f` when the order was cut (`dev/v0101-team/tasks/task-Lead-Services-45.md`). Read, not run: no test and no probe holds the case. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: the reading and a probe are accepted; what a write must answer is ruled after them. With the reading below before them, the owner ruled later that day, as the lead recommended: accepted for a build. A standalone save carries a hash of what its writer loaded, optional on the wire, and the route answers its conflict when the file's bytes differ from it.

## What was seen

A write through the standalone Files routes carries the token that its writer last saw for the file, a modification time in nanoseconds. By the lead's reading of `standalone_write_sync` and `check_write_preconditions` in `crates/chan-server/src/routes/standalone_fs.rs`, for which the order gives no lines: the production path compares the file's current metadata on disk with the requested token, lets a retry with identical bytes through, and checks the bytes and metadata it observed again through the filesystem's compare-and-swap primitive; and "no source invariant promises distinct timestamps per write".

The order corrected two tests that had assumed a second write changes the token. As corrected they show what a token that differs from the disk's does: changed bytes are refused with 409 and the current token and the file is kept, and equal bytes are accepted. By the builder's report they "do not cover a changed-content request whose stale token happens to equal the current token because an intervening content change retained the same mtime", and the lead's acceptance says that the work "does not establish protection when different disk bytes retain the same mtime token before a request".

So the case is: a writer holds the token of the bytes it loaded; another writer changes the file and the file's modification time stays the same; the first writer saves. Its token equals the current one, so the comparison the lead read finds no conflict. That the write then replaces the other writer's bytes is inferred from that comparison and is not shown.

Not established: the write's outcome in a run; whether any later check on the path catches it; how a change comes to keep a file's modification time, whether by two writes inside one tick of a filesystem's clock or by a tool that sets the time back; and how coarse that clock is on the filesystems chan is used on.

## Desired contract

Not written yet: the records name the limit and do not say what a write should answer when the bytes on disk differ and the token does not.

## What to do

A reading first, with lines, of what the write's precondition compares beside the token, and a probe that holds the case. Then decide.

## Boundaries

By the order's citations: `standalone_write_sync` and `check_write_preconditions` in `crates/chan-server/src/routes/standalone_fs.rs`, with its tests. The workspace routes' own write conflict is not read here.

## Acceptance

1. A reading and a probe say what a write answers when the bytes on disk changed and the file's token did not.
2. The owner's decision on it is recorded.

## Reading of 2026-10-03

Read and probed on the v0.102.0 integration branch, as the owner accepted. `standalone_write_sync` (`crates/chan-server/src/routes/standalone_fs.rs`) compares a request's token with the file's current mtime and nothing else of what its writer loaded; equal bytes pass whatever the token. The probe (`a_token_equal_to_the_mtime_of_changed_bytes_is_accepted_over_them`, in that file's tests) writes through the route, changes the bytes on disk and stamps the mtime back to the token: the next save with that token answers 200 and the file holds the saver's bytes. The probe restores a timestamp the filesystem itself reported, so it does not depend on the filesystem's granularity; how often two writes share one timestamp without a tool was not measured. The committed test states today's answer, and a fix turns its last two assertions around. What the write must answer is the owner's to rule: the route keeps nothing of what its writer loaded, so a refusal needs the client to send a hash or a length of it.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files, an independent review of its whole diff and the lead's own reading of what that review questioned. This record was written that day from those.

The server's half is built, and the row stays open for the page's. A save of the standalone Files tenant can carry `expected_sha256`, a query parameter of `PUT /api/fs/{path}` (`StandaloneWriteQuery`, `crates/chan-server/src/routes/standalone_fs.rs`): 64 hexadecimal digits, SHA-256 over the UTF-8 bytes of the text its writer loaded. With it the route answers its existing 409 when the file's text hashes otherwise, when the file cannot be read as text, and when it is gone; a value of another shape answers 400 before the body is read; without it a save answers as before, which the probe above still pins. The hash is held against the same capture that the conditional write compares again at the write, so nothing passes between the two (read by the review). It is computed by `chan_workspace::loaded_text_sha256` (`crates/chan-workspace/src/rooted_fs.rs`), so the server's manifest gains no dependency. Pinned red first; the workspace tenant's save does not read the parameter. Left: the page sends no hash yet, so no save is protected until it does. That half is ordered: the page hashes the text a load delivered before the editor normalizes its line endings, and after a 200 the body it sent, and sends none on a create. A page outside a secure context has no `crypto.subtle` and sends none, so its saves stay as they are.

The request's half was built later that day, in a range the lead accepted on its report, its status files and its own reading of the range's code: `api.write` takes the text its caller's writer loaded and sends its hash as `expected_sha256` on the standalone surface where `crypto.subtle` exists (`sha256Text`, `web/packages/workspace-app/src/api/client.ts`); every other request is as it was. Pinned with the server's own two digests and its fixture of a byte-order mark, CRLF, a lone CR and a two-byte character, and with that fixture read through the stream reader in several chunks, which hashes as its bytes. The row stays open: nothing calls the seam yet, so no save is protected. Left, and ordered after the range that holds `web/packages/workspace-app/src/state/tabs.svelte.ts`: `performSaveOnce` hands the tab's loaded text to the request, and the conflict dialog's Overwrite sends no hash, since it retries over bytes the tab did not load.

The tab's half was built later that day, in a range the lead accepted on its report, its status files and an independent review. A save from a tab on the standalone Files surface hands the text its last load or accepted save left it to the request, which names its hash, so a save over bytes the tab did not load is refused, the buffer is kept and the conflict prompt opens; Overwrite's one write names no hash, and a save that holds no loaded token sends none (`performSaveOnce`, `web/packages/workspace-app/src/state/tabs.svelte.ts`). `web/packages/workspace-app/src/design.md` says what a standalone save carries. The row stays open for one path its review found: an Overwrite whose write gets no answer leaves the tab with the conflict's token and its older loaded text, so the next save is refused by its own hash and the prompt opens again on a file nobody changed; no text is lost and the save can still be made. Also left: the block anchor's write passes no loaded text.
