# release-v0.83.0

v0.83.0 delivers one searchable command launcher across every Chan surface and a first extension surface, closes the gateway security review's remainder, masks secret-shaped values in the terminal, makes Kimi a named submit agent, and gates the team spawn poke on terminal readiness instead of a fixed sleep.

The launcher took two attempts. The first put the deck in a reusable transparent Tauri overlay owned by the desktop process; it produced six defects in sequence and was withdrawn after hand-testing on macOS and Linux. The second renders the deck inline in the SPA that owns the focused window, with authority following the rendering SPA, and is what ships. See the retrospective.

## What shipped

**One command launcher across every Chan surface.** A single searchable command deck, rendered inline by the SPA that owns the focused window, replaces a different action set reached through different code per surface. Authority follows the rendering SPA rather than being handed to the invoking page. The empty query opens a contextual deck ordering focused tab, pane and window actions before Computers actions; typed search may jump across nested levels while still stopping at every required argument and confirmation. This is the second implementation; the first is in the retrospective.

**Extensions v1.** A TOML-declared extension runs as a supervised subprocess behind an iframe tab, with host capabilities, declared commands, and a proxied endpoint. The extension's endpoint and token are their own trust domain: chan hands the iframe the endpoint and otherwise stays out of the extension's auth.

**The gateway security review's remainder landed, with two of its own claims corrected.** Entry-path failures are now registry-independent: method, Origin, Content-Type and the bounded one-field form are all validated before the registry is consulted, and every entry-specific 404 uses one JSON shape regardless of `Accept`. The original commit claimed that property but did not have it: two 404 constructors disagreed on whether they honored `Accept`, so an unauthenticated caller could distinguish "exactly one live devserver" from "none or several" by the response Content-Type alone, and the regression test passed only because none of its cases sent an `Accept` header. The identity SPA's new Content-Security-Policy also blocked the OAuth provider avatar the profile page renders and never proxies; `img-src` now admits it, and the policy test asserts the literal string rather than the constant it is generated from, so a weakened policy fails. Two further findings were investigated and dismissed against the deployed configuration rather than patched: the tightened `X-Forwarded-For` parse is correct because the edge discards inbound XFF and emits a bare peer address, and the SPA's missing `nosniff` and `Referrer-Policy` are supplied at the edge.

**Terminal secret masking.** Values whose variable name looks secret are masked in the terminal, driven by two config fields with a Settings surface. Two defects were fixed before merge, both found by adversarial review of the implementation rather than by its tests. A `secret_mask_suffixes` entry containing a character outside `[A-Za-z0-9_]` failed the whole config parse; the server then fell back to defaults in memory, and the next settings write persisted those defaults over the user's entire `server.toml`. A hyphen cost every other setting in the file. Separately, the scan degraded to a full-scrollback rescan on every PTY write once scrollback reached its cap, which is the steady state of any long-lived terminal, while the code comment and the item both described that as a rare case. Seven further findings were adjudicated: the fail-loud contract was unreachable in the shipped xterm, the pattern backtracked quadratically (10k characters in 217 ms, 40k in about 3 s, against 0.10 ms after a linear rewrite), a duplicate suffix crashed the Settings pane, and the item's claim of universal coverage of the repository's own workflow secrets was false and is now stated accurately.

**Kimi is a first-class submit agent.** `SubmitAgent` gains `Kimi` with its own measured chord rather than an alias of codex's, the command sniff resolves a bare `kimi` or an absolute launcher path, and the TypeScript mirror moves in lockstep. A team member running kimi previously derived to a shell: no submit chord, no identity poke, and `cs terminal write --submit` writing raw bytes and exiting 69. The working practice was to declare `CHAN_AGENT = "codex"` so kimi masqueraded as codex, which held only because the two clients happen to share an encoding, with nothing recording the dependency.

**The team identity poke waits for the member's terminal.** `cs terminal team new` delivered each agent its identity poke after a fixed three-second grace, and a member whose TUI was not yet in control of the PTY never received it: the bytes went to whatever program was foreground, the agent started with an empty compose box, and the round stalled before it began, indistinguishable from a member that was working. The poke now gates on the PTY entering bracketed-paste mode, with a bounded wait; a member that never signals readiness is named in the spawn summary and makes the command exit non-zero. Measured: kimi cold-boots to TUI-ready in 3.11 s against that 3 s grace, so it lost the race whenever its caches were cold and won when they were warm. The failure was nondeterministic, not absent.

**`cs tunnel <port>` is shorthand for `<port>:<port>`.** A lone port after the bind-address peel is used for both ends. `cs tunnel 0` stays refused, because expanding it gives a devserver port with nothing to dial, and `1.2.3.4:8080` keeps failing as an invalid desktop port, because the shorthand cannot fire on a spec that still holds a colon.

**Every v0.83.0 roadmap item is now true against the tree.** Six item documents carried claims that no longer matched the code: wrong line anchors, symbols that had moved, counts that were simply wrong, and in one case a premise that a page did not exist when it had shipped weeks earlier. A worker verified each finding against the tree before acting and refused five of the forty-two as wrong.

## What did not ship

**Six items move to v0.84.0**, none of them picked up during the round: `cs-open-non-text-reveal`, `hybrid-nav-staged-editor-bubble`, `terminal-tab-rename-reaches-inventory`, `terminal-editor-appearance-settings`, `large-transfer-capability`, and `web-marketing-onboarding`.

## Team and process

One lead on Claude Opus, workers on codex `gpt-5.6-sol` at max reasoning and kimi K3 at max thinking, each in its own git worktree on its own branch. Two items were executed on a separate machine by a remote agent.

Every lane brief framed prior findings as leads to verify rather than facts, and required workers to report anything they could not confirm. That requirement did more work than any brief. The docs lane returned five of forty-two findings as unconfirmed, three of which were the audit being wrong, and corrected the audit's detail while keeping its direction. The secret-masking lane confirmed seven findings, refused half of an eighth with reasoning, and measured the ReDoS claim rather than arguing it. The launcher lane falsified two of the lead's own hypotheses with tests.

The lead's error rate is the honest headline of this round. Three separate hypotheses about one launcher defect were wrong. A fix for one race created another. A roadmap table row landed outside its table twice. A `cargo fmt` failure and an `npm install` failure were each masked by the lead's own shell constructs. The lead edited a file another agent had open, immediately after instructing every lane not to. A local release-candidate ref was silently advanced past its remote and was caught by an agent reporting a ref it had not touched.

## Validation

The gateway security lane and the launcher lane each ran the full `make pre-push` end to end, including the AppImage build and the AppImage devserver smoke. No integrated candidate was ever gated in full, because the release parked before that step.

Per-lane: chan-desktop 334 tests; chan-server 953; chan-library 275; launcher 320 across 42 files; workspace-app 3,217. Every fix that had a test was taken red first and the red captured, including the launcher's `parseDeckDraft` restore, the key-bridge gate ordering, the revision monotonicity invariant, and the secret-masking throw paths.

Three failures during the round were environmental rather than code: a full disk killed a full gate, an e2e link step, and three browser-smoke attempts. With eight worktrees each carrying a multi-gigabyte Rust target, the machine could not hold the round's shape.

## Retrospective

**The overlay was the wrong shape, and the release found out the expensive way.** The first launcher implementation put the deck in a reusable transparent Tauri overlay owned by the desktop process. Six defects were found and fixed in sequence and the feature still did not work: a hang on every awaited command, a chord swallowed on windows served by an older devserver, a fresh source's first snapshot rejected as stale, a late save mutating another owner's draft, a new race created by the fix for the third, and a window positioned in physical pixels while hidden. A seventh symptom, Computers branch rows not navigating, was never explained.

Five of those six are ownership, revision, or synchronization defects that exist only because the deck is a separate native window shared across sources with its own draft state; the sixth is native window placement. None of them exist for a deck rendered inside the page that invoked it. The design's justification, that a remote devserver page must not receive the desktop's aggregate inventory or bearer, is real but binds only for remote windows, while the overlay was applied to every window class.

The overlay was withdrawn and the deck rebuilt inline, which is what shipped. The full evidence, including three hypotheses raised and falsified and the one discriminating test never run, is archived with the round.

**Adversarial verification paid for itself repeatedly, and the lead was its most frequent subject.** The pattern that worked was not better briefs; it was requiring every worker to report what it could not confirm, and treating a clean automated result as insufficient. The launcher's clean auto-merge with extensions-v1 produced zero textual conflicts and told us nothing, because the two rewrites lived in different packages.

**A fix that creates the next defect is a signal, not bad luck.** Making draft revisions globally monotonic fixed a real rejection bug and immediately created a new race by putting the host cursor and a speculative client counter into one number space. That is the third time in this round that a change to the launcher's synchronization surfaced another problem in it.

**A gate with no headroom is a gate nobody can act on.** The launcher bundle sat four bytes under a hard ceiling; the next launcher fix put it two bytes over and failed the build for a reason unrelated to bundle size. The ceiling was raised deliberately after confirming no heavy import had landed, and its comment now states the real size.

## Follow-ups

- `extensions-v1` browser-smoke check 122 fails deterministically. Diagnose it before the branch is reconsidered; a clean merge and green Rust tests are not evidence the feature works.
- Both Nix fixed-output hashes in `packaging/nix/chan-desktop.nix` need re-pinning whenever the lockfiles regenerate. They were stale through this round and are the reason v0.81.0 shipped without Cachix.
- Decide whether the launcher SPA's gzip ceiling should track the bundle automatically. It sat four bytes under the limit during this round and failed a build for a reason unrelated to bundle size.
- The withdrawn overlay's known defects are recorded with the round's artifacts, including one worth fixing wherever the deck lives: in `CommandDeck.execute` the non-awaited branch runs outside its try/catch, so a throw is an unhandled rejection and a failing row looks identical to an inert one.
