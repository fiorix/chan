# release-v0.77.0

v0.77.0 is a correctness release for workspace lifecycle, persistence, configuration, and collaboration. It closes reachable reset and write-order races, makes hosted shutdown own and await tenant work, removes compatibility paths that no longer have consumers, keeps workspace session bytes opaque, and adds end-to-end coverage for startup cancellation and root loss. The release also turns the shipped native, distro, and container surfaces into an ordinary CI build matrix instead of relying on Linux Rust tests or the publication workflow to discover platform drift.

This cycle is cut directly to GA with no RC pin. The `0.77.0` commit remains untagged until the exact commit passes the local pre-push gate, a `release.yml` dispatch with `publish=false`, the separate cache-only four-image downstream rehearsal, and artifact inspection. A red rehearsal is a stop condition for the release owner.

## What shipped

**Workspace access and reset fail promptly under contention.** The live workspace and indexer use nonblocking snapshots with distinct busy, missing, and poisoned outcomes. Reset releases its own session-closing reference before drain, genuine external holders receive bounded retryable behavior, and route callers return HTTP 503 with retry guidance instead of parking Tokio workers or panicking on a transient generation.

**Persistence and configuration updates are ordered and durable.** Terminal blobs and devserver configuration publish through unique same-directory temporary files with cleanup on failure; devserver token and mint-time state serialize snapshot through publication. Dashboard updates use one dedicated serialization boundary and screensaver PATCH performs one durable transition. Global preferences use revisioned partial owner-specific writes, so stale windows receive a conflict and bounded replay instead of silently overwriting unrelated fields.

**Collaborative lifecycle state is shared without combining domains.** Document and scene sessions share their identical lifecycle state, conflict metadata, merge outcomes, and HTTP views in one private module. Document changesets, scene identity-aware merge, wire frames, recovery payloads, and domain authority stay separate. Independent bounded Unicode-scalar edits on the same line now merge after common context is stripped; genuine overlap still enters explicit conflict resolution.

**Hosted shutdown completes owned work before clearing the workspace.** One tenant task owner carries the existing cancellation signal and task handles, joins cooperative document, scene, terminal, reap, and reconcile work to one absolute deadline, then aborts and awaits all stragglers. Cancellation-safe reaping removes completed handles immediately, and abort-on-drop remains a fallback rather than the normal path.

**Workspace close and root loss fail closed.** `chan close` and `chan close --remove` serialize against startup registration, reconcile the newer intent before publication, and cannot be reversed by stale startup completion. Once an opened root disappears, identity checks prevent files, drafts, terminals, graph requests, or background work from recreating it. The file browser and graph converge to unavailable, while a dirty editor retains its in-memory buffer and reports the missing file.

**Compatibility-only work leaves the hot paths.** Workspace open no longer parses or prunes host-owned session JSON. The dashboard re-home migration, duplicate configuration and workspace mutation routes, no-op GPU environment handling, launcher readonly fallback, obsolete tests, and unused watcher helpers are removed after whole-repository consumer searches. Search mode and terminal cwd filesystem work execute off async workers, and missing-file recovery uses one deterministic basename contract without an N+1 graph lookup.

**The repository builds what it ships before publication.** Ordinary CI builds and packages Linux, macOS, and Windows desktop surfaces; direct Linux packages; COPR and PPA sources; both AUR packages; the chan image; and all four gateway images. A static contract binds those jobs to the real Make targets. Pre-push boot-smokes the release CLI and the native Linux AppImage or ad-hoc-signed macOS app. The macOS Xcode selector no longer depends on GNU `sort -V`.

**End-to-end lifecycle expectations are executable and reusable.** `scripts/e2e/scenarios/workspace-lifecycle.md` records fourteen owner-run scenarios covering startup, close, remove, shutdown, collaboration, session restore, index and graph readiness, file-browser state, and root loss. Browser check 98 exercises the destructive root-loss tail over an expanded tree, maximum-depth graph, and dirty roughly 2 MiB editor document. Generated team bootstrap guidance also requires quiet turn breaks so terminal notification queues can drain at safe checkpoints.

## Team and process

One Codex lead coordinated three Codex worker lanes in separate worktrees: Runtime owned atomic persistence, async isolation, and task lifetime; Config owned dashboard and preference concurrency, search placement, and compatibility cleanup; Sessions owned collaboration characterization and the narrow shared-state extraction. Contracts were frozen before each dependent wave. Every lane began correctness changes with deterministic red evidence, reported its scoped gate, and held for ordered integration.

The lead preserved ancestry and the Runtime, Config, Sessions, then Lead construction-point order at each checkpoint. Follow-on root-loss, collaboration, smoke, documentation, and build-matrix work landed on the integrated baseline without reopening completed worker waves. Documentation prose and current-state comments received separate commits, and the cross-platform build work remained separate from the GA pin.

## Validation

- Deterministic reset regressions prove handler-owned references no longer block drain, reset contention does not starve a single-worker runtime, real external holders restore the old generation, and retry opens the replacement generation.
- Atomic publication tests cover same-key concurrent terminal writes, concurrent devserver saves, `0600` token files, ordered rotations, interrupted byte production, prior-target preservation, and temporary cleanup.
- Integrated workspace and server checkpoints passed: 633 workspace tests with 2 intentional ignores and 880 server tests, plus all-target Clippy with warnings denied. Focused collaboration suites passed 2 shared, 64 document, and 63 scene tests.
- Hosted shutdown coverage proves the document close-all flush completes before workspace clear, all cooperative handles join, a mixed stuck set shares one deadline, aborted handles are awaited, cancellation retains only unreaped handles, and the persisted overlay survives.
- The startup-close regressions passed both literal `chan close` and `chan close --remove` host paths. Root-removal unit and browser coverage pins non-recreation, typed failure, graph and file-browser convergence, and dirty-buffer retention.
- Linux package evidence on the committed build-matrix snapshot includes a release CLI boot smoke, AppImage packaging and boot smoke, direct deb and rpm builds, both COPR SRPMs, unsigned noble PPA source packages, both AUR packages built and installed in clean Arch containers, and the chan plus four gateway container images.
- Shellcheck over 47 scripts, actionlint, the build-matrix contract, format, and diff checks passed after the final build-matrix edit.

The exact GA commit still requires the complete `make pre-push` gate after its version bump. Native macOS signing, notarization, stapling, updater signing, and signed Windows packaging remain proven only by the mandatory `publish=false` release workflow. The owner-run browser suite, real-hardware desktop interaction, large-repository startup, BuckOS semantic/report soak, and OSC 52 clipboard check are not represented as locally gated evidence.

## Retrospective

**Highlights.** Deterministic barriers turned reset, persistence, startup-close, and shutdown lifetime assumptions into exact red and green evidence. The narrow collaboration extraction deleted duplication without creating a generic merge or wire framework. Root-loss testing treated the file browser, graph, editor, and new-surface failures as distinct convergence contracts instead of reducing the case to one health endpoint.

**Lowlights.** Filtered lane gates could not prove cross-lane lifecycle behavior; the full integrated server suite and explicit caller inventory were still necessary. The cross-platform build matrix required substantial local artifact and container validation before it was safe to automate, and its first AppImage smoke exposed argv0 dispatch through AppRun rather than a product-code failure.

**Honest feedback.** A Linux-only green gate was not an adequate proxy for a desktop product whose primary shipped surface is macOS. Binding every shipped surface to a real native, distro, or container target makes failures earlier and attributable, but the signing and GUI paths still require native CI and owner judgment. The owner-run lifecycle catalog is deliberately not in pre-push; it should graduate scenario by scenario only after stable repetition across hosts.

## Follow-ups

- Run the manual or bounded WL-01, WL-11, and WL-12 startup, graph, and shared file-browser scenarios until each has a stable named check.
- Keep WL-14 destructive and owner-run until its filesystem and UI convergence has proven stable across hosts.
- Run large-repository Linux and BuckOS startup soaks with recorded file counts, memory, and milestones; do not substitute them for deterministic fixtures.
- Validate one real OSC 52 clipboard write on supported terminal hardware.
- Inspect native macOS and Windows artifacts from the mandatory `publish=false` run before creating the GA tag.
