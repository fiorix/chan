# Release v0.92.0

Status: GA 2026-08-17. Two candidates, neither tagged. The round's scope was one documentation item, one investigation, and four already-written fixes; what it also produced was a measurement of a fix nobody had questioned, and three browser-smoke checks that were failing for reasons unrelated to the product.

## What shipped

- **The gateway has a canonical design.** `gateway/design.md` is new and explains, in one place, how one `chan-desktop` account discovers a gateway, signs in with PKCE, receives a roster of owned and shared devservers, and enters a selected devserver through its exact proxy origin, alongside how each devserver publishes itself through an outbound tunnel. Four Mermaid diagrams carry the deployment boundaries and the publication, account, and entry sequences. Twenty-four documents were read against the live implementation rather than against each other, which is what removed the stale claims the item existed for: automatic database migrations that no longer exist, old ports and local origins, one-devserver-per-user assumptions, an admin service rather than the admin CLI, retired tunnel flags, and revocation and systemd behaviour that had drifted from the code. `gateway/CONTEXT.md` is a glossary again, and the redundant Linux/macOS testing stub is gone with its three inbound links retargeted.

- **Workspace terminals survive a devserver restart.** Restoring the fd store ran before persisted workspace tenants were mounted, so a shared-terminal PTY survived a restart because its tenant already existed while a workspace PTY was rejected and its child killed. Persisted workspaces now mount before inherited sessions are applied, and mounted tenant routes answer 503 with `Retry-After: 1` until restoration, adoption, and continuous parking have finished. Root health and management routes stay responsive throughout, on the direct listener and through the gateway tunnel alike, and a shutdown before the parker activates leaves the inherited manifest untouched.

- **A terminal renderer no longer caches glyphs before its font loads**, and a directory graph opened with "Graph from here" reveals deep enough to show its files when its immediate children are all directories.

- **The About surfaces agree.** The native window ends with the margin it starts with, and the dashboard About card now carries the running binary's build id on its own row so two builds of one version are distinguishable from inside the app. The Apache 2.0 link left that card; the licence lives in the repository.

- **Three browser-smoke checks stopped failing for reasons that were never about the product**, and one investigation closed without a code change.

## Team and process

A five-member team ran the round: a lead plus Editor (the external-edit investigation), Merge (landing the written work), Gateway (the documentation item), and Gate, which owned the single build container and wrote no source. Lanes were file-disjoint and every build and check went through Gate, because two `make` runs against one target directory both crawl on a file lock and the second one looks like a hang. The team was torn down at the end of the round and two follow-up agents finished the remaining work: Smoke on the browser-smoke checks, and one on the devserver restart path.

Two process choices did more work than the rest.

The first was **pre-registering what a result would have to look like before measuring it**. Merge wrote down that check `114` should first scroll at height 460 with 32 pixels above and below, before the check had ever run; it returned exactly that, which turned a bare PASS into evidence that the check measures the box it claims to. The lead wrote down attribution thresholds for `111-graph-palette` before either arm existed, and a predicted final-suite set before the gate ran.

The second was **judging every verdict as a delta against a measured baseline**. The container failed 12 of 44 checks on unmodified code, so a check red in both runs was never this round's problem and a check that flipped always was. Without that set, the round would have spent itself on environment gaps.

The host was unreachable by survey for the entire round: no SPA window was connected, so the overlay had nowhere to render. The lead discovered this only after believing a survey was open and waiting, which is recorded below.

## Validation

- Baseline browser-smoke on the unmodified base: 31 pass, 12 fail, 1 skip of 44, runner exit 1, 9m40s. Final suite on the candidate: 34 pass, 11 fail, 1 skip of 46, with the failure set matching the baseline's own less one, and the two checks added by this round passing.
- `make pre-push` green on every candidate and on the GA commit, including the separate gateway workspace, the release devserver smoke, and the native AppImage build and smoke.
- `111-graph-palette` measured across 50 runs, 25 per arm, in an isolated worktree with the binary and bundle built per arm; both void controls verified, the binary path recorded inside that worktree and the two bundle hashes different.
- The rewritten `111` proven in both directions: 25 consecutive passes, and a deliberately perturbed renderer that retained a retired hue drove it red at 475 pixels against a bound near 100.
- The workspace-PTY contract exercised end to end against a real `systemctl --user` unit: a shared-terminal PTY and a workspace PTY carried through a bare restart, `chan devserver --restart`, watchdog recovery, and SIGKILL recovery, with the fd store count asserted after every phase.
- `/api/build-info` checked against a live server rather than inferred, and its build id confirmed identical to what `/api/health` reports.
- The four Mermaid diagrams parse with the repository's own Mermaid. There was no tooling for this; a checker was written for it, and on its first working run it found one of the four diagrams did not parse.
- The owner built the candidate on macOS and confirmed the native About window on WKWebView.

## Retrospective

**Highlights.** The pre-registration paid for itself twice. On `111-graph-palette` the lead found a real mechanism early, drew the conclusion that the graph change was therefore not implicated, and told a lane so. The full measurement then contradicted it: 23 of 25 against 17 of 25, with zero-residue runs falling from 16 to 8 and a rank comparison at p = 0.027. Only the threshold written down beforehand kept the first, wrong answer from becoming the round's answer.

Building tooling for an acceptance line that had none was worth it immediately. The item required four diagrams to parse with the repository's Mermaid tooling; no such tooling existed, only the npm dependency the app renders with. A small checker written against it found that one diagram used a semicolon, which Mermaid treats as a statement separator, so the canonical entry lifecycle would have rendered as an error. Reading the four diagrams would never have caught it.

Two traps were caught before they cost a result. A comparison of two trees was about to be run with one shared binary, which in a debug build reads its frontend bundle from a path fixed at compile time, so both arms would have served the same bundle and produced a confident, meaningless answer. And a check being considered for permanent adoption turned out to be structurally incapable of failing, because the runner marks a check passed the moment it returns.

**Lowlights.** The lead reached two premature conclusions about the same check, both from partial data, and both reached a lane before the correction did. The failure screenshots that settled the question had been retained the whole time and Gate had said so. The lead had also instructed Gate that a different check's screenshot, not its log line, decided its verdict, and then failed to apply that rule to this one.

The lead started new work while a gate was running against the same tree, which is the exact thing it had warned Gate about during the baseline. That run's verdict had to be discarded and the work re-gated on a frozen tree.

The survey channel was unavailable for the whole round and the lead did not notice for some time, having read a command that blocked as a command that had succeeded. A command that hangs is not a command that worked, which is the same lesson a non-zero status file taught earlier the same day.

**Honest feedback.** The round's most useful artefacts were the ones written before the evidence: a predicted pass set, a predicted margin measurement, a threshold table. The least useful were confident summaries written from partial runs. The difference between them was not care, it was ordering.

## Follow-ups

- The browser-smoke suite has checks whose assertions depend on timing, ordering, or a sampled baseline rather than on the property they test. Four instances are now known: the binary-transfer fixture contract that cannot be met in a container, the palette check's sampled tolerance, and the latency and root-loss checks that failed only under suite load. `123-hybrid-nav-stale` is a fifth, observed alternating four times with nobody touching it. This reads as one suite-design item rather than five defects.
- `56-external-edit-matrix` fails only on whether the new content reached the editor and never inspects the conflict banner, so it can go red on correct behaviour. Whether its contract should become merge-or-visible-conflict is open.
- Nothing in the suite presses Ctrl+S while a conflict is pending or asserts the `Keep mine` resolution, so the half of the external-edit acceptance precondition that guards against a silent no-op save is unguarded.
- Two operator-facing gateway configuration contracts contradict the runtime: a packaged comment claims `MAX_DEVSERVERS_PER_USER=0` disables the cap where the parser rejects zero, and identity's crate-default internal bind address collides with profile's default while the admin CLI defaults to the public listener that does not serve the admin routes.
- A workspace-scoped graph whose root holds only directories still opens without files. The reveal added this round is deliberately limited to directory scopes.
- `POST /api/library/command-capabilities` answers 404 on page load. Five observations, no failed check, no demonstrated consequence, and deliberately not opened as an item.

## Known gaps

- The Nix fixed-output hashes were harvested at GA rather than per candidate, by decision: no candidate check reads them, and the only place they are verified against a real build is the release commit's own CI run. The trade is that GA is the first harvest for the version.
- The native About window was confirmed on macOS and WKWebView by the owner. WebKitGTK was never exercised; the round's container has no display and no GTK or WebKit runtime.
- The external-edit item closed as not a defect on the mechanism, not on the history. Whether the original failing runs had the input shape that makes a retained conflict correct cannot be established: the preserved artefacts record no durable baseline, authority version, or flush epoch, and were searched to confirm it.
- The graph directory reveal ships with a measured, sub-visible increase in retired-hue fringe pixels, accepted knowingly. Whether that indicates an element is not fully repainted is unanswered; pixel counts cannot decide it.
