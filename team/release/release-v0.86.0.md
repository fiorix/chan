# Release v0.86.0

GA 2026-08-08. Thirteen roadmap items closed across two team rounds and an owner fold-in, with the release cut authorized end to end through the integrator session and no pre-GA hand-smoke; the owner tests in production as its only user.

## What shipped

- **Extensions through the gateway**, the release's late centerpiece, found live on the integration build the day of the cut: the gateway session gate 404'd every cookieless request, and a sandboxed extension iframe's module-script fetches are cookieless by spec, so extensions had never booted on a gateway-served window. The gateway now admits exactly the extension capability path shape, the devserver's per-process capability check remains the authorization, every response leaving the extension namespace on either binary carries CORS headers, the capability segment is redacted from both binaries' trace spans, and extension tabs converge after a devserver restart instead of holding a dead capability. Proven by a committed e2e scenario driving a real local gateway fleet with a real tunnel handshake and a headless-browser sandboxed iframe, red-proven against the pre-admission proxy reproducing the live incident verbatim.
- **`cs terminal new`/`restart --command/--env`** on shared plumbing, closing the burn from the v0.85.0 round where a live shell tab was permanently unpokeable; the restart surface is the repair path the original item missed, found in re-verification.
- **Runtime build identity for chan-desktop and the native vocabulary query**, the two halves of the version-skew item; the identity gap cost this same release another diagnostic hour server-side and is registered forward for the devserver.
- **Deterministic editor widget tests**, where the investigation disproved the presumed mermaid race and found a production staleness bug instead: StateFields blind to an effects-only tree publish, fixed on tree identity in the walker.
- **Archive ceiling bounds on both transfer arms** with refuse-before-first-byte or a mid-stream body error; the item's other two gaps closed by ruling rather than code, one of them overturned by a source ruling that landed three hours after the item was written.
- **Source pins on unique needles across the whole 24-site class**, with a committed mutation probe; the original three-pin boundary was widened by ruling.
- **Gateway tests in the gate** (database-free suites executed, the seven Postgres-backed files reported as not run) and the **npm 10 floor** on the web lockfile check, whose destructive-npm premise re-verification falsified and re-scoped.
- **The team-config pane layout** owner fold-in, and the **empty-pane mark flash**.

## Process

Two rounds: a five-member claude+codex round on four disjoint worktree lanes, then a two-member fix round for the extension class after the owner's live test. Pre-round verification re-validated every accepted item against the tree and falsified one item's premise, narrowed another's contract, and forced two scope rulings; the round briefs froze wire contracts and the host-poke workaround for an agent-less host tab. Integration was owner-session-driven: lanes merged on own-gate green with two composition fixups (a 76-column help-wrap pin and a Tab-union narrowing), both in files two branches touched without conflicting.

## Validation

- Full 15-step gate green on the integrated tip, including the new gateway-test step; the pre-cut full gate over the since-release window caught one load-sensitive flake, classified against 20 isolated and 5 full-parallel green runs and registered forward rather than discarded.
- Extension e2e scenario green on the integrated tip; windows-cross-check green; release.yml publish=false dry run and the docker/cachix publish-downstream dry dispatches green on the integration branch.
- The GA commit's own ci.yml run green including Nix chan-desktop, verifying all three re-pinned fixed-output hashes against real builds before the tag.

## Retrospective

Highlights: the live incident's three-layer diagnosis (stale binary, stale capability, gateway admission) each produced a registered item or a shipped fix within the same day; cookieless curl probes from a second machine settled the root cause without touching the owner's session; re-verification before the round caught a falsified premise and a source ruling that had silently overtaken an accepted contract.

Lowlights: the devserver restart trap (a supervised restart relaunches whatever binary the service names) burned the first diagnostic hour and is exactly the registered devserver-build-identity item; the host tab's inability to receive submits (`cs-terminal-new`, now shipped) made member-to-host pokes raw-write fragile for a second consecutive round; a same-name tenant prefix on two machines sent one diagnostic probe at the wrong devserver.

Honest feedback: the roster grew by six items during the release window, five from a single live test; without the owner's explicit no-smoke ruling this release would have slipped a day on scope found after the round closed. Registering live findings as items with evidence, then deferring the unstarted ones wholesale at the cut, kept the boundary clean.

## Follow-ups

- v0.87.0 carries notifications, desktop-authorize (specced, with a recommended no-new-page shape), the scene conflict-test flake, devserver build identity, and AUR restoration, which remains blocked on a superseding Arch announcement as of 2026-08-08.
- The skew item's live version-skew reproduction and the extension lane's production-tunnel acceptance ride the owner's in-prod testing, recorded here rather than in a pre-GA gate.
- The parked computers-scope-from-any-window draft (launcher extension) stays in the dev tree for a future cycle.
