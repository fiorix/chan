# Release history

The development history of chan, one consolidated report per release era. Each `release-{NN}-{version}.md` is that era's front door: its roadmap (the asks), how the rounds and waves were structured, who worked it and how they coordinated, what shipped, and a retrospective with the lessons worth carrying forward. The `NN` prefix orders the reports chronologically; the version marks the release(s) the era shipped (`prerelease`/`unreleased` where no tag was cut). Going-forward reports drop the `NN` prefix and are named for their release (`release-v{version}.md`); a release cut through release candidates keeps its per-cycle rc reports (`release-v{version}-rc{N}.md`) as indented sub-entries under that release.

These reports are the project's second brain. The raw per-author journals and coordination buses that backed them were distilled into these files; the raw material is preserved in git history.

New agents should also read [`.agents/playbook.md`](../../.agents/playbook.md), the operational lessons distilled across the project.

## Index

- [release-01-prerelease](release-01-prerelease.md) - first public release prep: filesystem graph, search status, CLI parity, hardening.
- [release-02-prerelease](release-02-prerelease.md) - graph, editor, and search hardening, plus language elevated into the graph.
- [release-03-prerelease](release-03-prerelease.md) - UI polish and the Assistant-to-Agent rename, URL state, and editor fixes.
- [release-04-prerelease](release-04-prerelease.md) - sparse bug-bounty placeholder; effectively a numbering skip from 3 to 5 (see the report).
- [release-05-prerelease](release-05-prerelease.md) - the MCP-only refactor, persistent terminals, and VCS-aware indexing.
- [release-06-v0.10.0](release-06-v0.10.0.md) - the filesystem made the primary graph layer, plus the folder-to-directory terminology change.
- [release-07-v0.10.1-v0.11.0](release-07-v0.10.1-v0.11.0.md) - project hygiene, Hybrid panes, and the agent-orchestration substrate.
- [release-08-v0.11.0-v0.13.0](release-08-v0.11.0-v0.13.0.md) - bug sweep, the signed-DMG pipeline, and public-flip preparation.
- [release-09-v0.14.0](release-09-v0.14.0.md) - the desktop-native vision, drive metadata isolation, and the Rich Prompt revamp.
- [release-10-prerelease](release-10-prerelease.md) - the desktop embedded-server merge and the public site and manual.
- [release-11-v0.15.5](release-11-v0.15.5.md) - the drive streaming spine, editor and graph fixes, and the release contract.
- [release-12-v0.16.0](release-12-v0.16.0.md) - the drive-to-workspace rename and the graph and File Browser carryover.
- [release-13-v0.17.0-v0.18.0](release-13-v0.17.0-v0.18.0.md) - the Graph and Dashboard rework, then the Team Work revamp.
- [release-14-v0.17.0-v0.18.0](release-14-v0.17.0-v0.18.0.md) - Gateway monorepo migration into a nested workspace, then a frontend review and pristine cleanup, plus paced graph hot paths and the new-workspace pre-flight relocation.
- [release-15-v0.20.0-v0.23.0](release-15-v0.20.0-v0.23.0.md) - Dashboard carousel, the cs CLI, Team Work plus the survey rebuild, and the indexing hardening thread.
- [release-16-v0.24.0](release-16-v0.24.0.md) - cs lead-tooling, a long host-driven feature and polish stream, and the chan-desktop launcher redesign.
- [release-17-v0.25.0](release-17-v0.25.0.md) - host bug sweep, survey v2, and the desktop connecting screen.
- [release-18-v0.26.0](release-18-v0.26.0.md) - hybrid-surface bug sweep (editor lists, graph, File Browser, inspector pills, terminal), the repo/docs fold, and the v0.26.0 release wave.
- [release-19-v0.26.1-v0.28.1](release-19-v0.26.1-v0.28.1.md) - Linux/WebKitGTK desktop parity, the in-tree Drafts model, the graph `@@mention` lens plus contact nodes and offline reconcile, and the .agents/ docs fold.
- [release-20-v0.29.0](release-20-v0.29.0.md) - chan-desktop refinements (plain-text update prompt, unified About) and standalone terminal windows, run as an orchestrator plus subagents round.
- [release-21-v0.29.0](release-21-v0.29.0.md) - terminal cross-window awareness: a cross-window broadcast roster (menu, indicators, toggle gate), per-tenant Terminal-N naming, group-wide cross-window Select All, and tenant-wide name uniqueness.
- [release-22-v0.31.0](release-22-v0.31.0.md) - window management: bury-on-close with a dynamic Window menu, Cmd+Shift+N per-connection semantics, remote window reopening over GET /api/windows, cs window list, the standalone-terminal control socket, the split-pane replay fix, and quit confirmation.
- [release-23-v0.31.1](release-23-v0.31.1.md) - the tidy-up: archaeology scrub, zero-warning hygiene, docs currency, the macOS file-drop takeover fix, and the chanwriter purge.
- [release-24-unreleased](release-24-unreleased.md) - the visibility round: editor keep-alive on tab switch, prompt-queue depth, buried-window memory and survey-first host comms, plus the standalone graph-keepalive web feature.
- [release-25-v0.35.0](release-25-v0.35.0.md) - chan-desktop acts as `chan` (one binary, no separate CLI download), the empty-pane window-save cleanup, and a folded-in rich-prompt enqueue/recall/reload round.
- [release-26-v0.36.0](release-26-v0.36.0.md) - Windows-first chan-desktop: the named-pipe control socket, the Git BASH terminal with a missing-Git in-app gate, NSIS packaging plus the windows-latest CI arm, and markdown iframe embeds.
- [release-27-v0.36.0](release-27-v0.36.0.md) - opt-in workspace lifecycle plus the v0.36.0 Windows smoke fixes.
- [release-28-v0.39.0](release-28-v0.39.0.md) - the chan devserver, and killing the default workspace.
- [release-29-v0.39.1](release-29-v0.39.1.md) - devserver and chan-desktop hardening.
- [release-30-v0.40.0](release-30-v0.40.0.md) - making the devserver window lifecycle actually work: reattach, discard, and the FD leak.
- [release-31-v0.41.0](release-31-v0.41.0.md) - one window registry: a watcher drives the local and devserver window lifecycle.
- [release-32-v0.42.0](release-32-v0.42.0.md) - devserver = chan-library: per-devserver gateway proxy plus library-owned open.
- [release-33-v0.43.0](release-33-v0.43.0.md) - web-launcher unification across all surfaces, embeddings honesty, and carryover.
- [release-34-v0.44.0](release-34-v0.44.0.md) - launcher reflects reality (workspaces and devservers), `chan open`/`close`, and the transfer bubble.
- [release-35-v0.45.0](release-35-v0.45.0.md) - the v0.45.0 desktop release: launcher, devserver-in-launcher, and lifecycle hardening.
- [release-36-v0.46.0](release-36-v0.46.0.md) - launcher polish, editor and graph fixes, and desktop hardening.
- [release-37-v0.47.0](release-37-v0.47.0.md) - devserver and launcher connect lifecycle.
- [release-38-v0.48.0](release-38-v0.48.0.md) - devserver and launcher window lifecycle, identity, and presentation.
- [release-39-v0.49.0](release-39-v0.49.0.md) - UI responsiveness, desktop cosmetics, tunnel e2e, and container packaging.
- [release-40-v0.50.0](release-40-v0.50.0.md) - terminal interaction, reload-state, CLI ergonomics, and desktop geometry.
- [release-41-v0.51.0](release-41-v0.51.0.md) - Windows desktop support, published (unsigned).
- [release-42-v0.52.0](release-42-v0.52.0.md) - the unification sweep.
- [release-43-v0.53.0](release-43-v0.53.0.md) - leader presence, the self-managed devserver daemon, and terminal scrollback resume.
- [release-44-v0.53.1](release-44-v0.53.1.md) - a Windows, clipboard, and editor patch.
- [release-45-v0.54.0](release-45-v0.54.0.md) - machine-first launcher, Docker publishing, editor polish, and chan open routing.
- [release-pub-site](release-pub-site.md) - a standalone branding and positioning re-steer plus marketing site refresh (not a numbered release era).
- [release-v0.55.0](release-v0.55.0.md) - editor polish, devserver hardening, docs consolidation, and the validation carryover into v0.56.0.
- [release-v0.56.0](release-v0.56.0.md) - design-doc cleanup, the `DEVSERVER_*` gateway contract, v0.55 validation carryovers, and devserver lifecycle hardening.
- [release-v0.56.1](release-v0.56.1.md) - control-terminal exit attention, launcher hover polish, and split desktop package targets.
- [release-v0.56.2](release-v0.56.2.md) - markdown list rendering fixes (guide bars removed, prose-aligned markers) and owner-side, typed workspace lifecycle state.
- [release-v0.56.3](release-v0.56.3.md) - markdown list alignment across marker types and platform-accurate pane shortcut hints.
- [release-v0.56.4](release-v0.56.4.md) - wide markdown table containment.
- [release-v0.57.0](release-v0.57.0.md) - systemd fdstore restarts and devserver close sync.
- [release-v0.58.0](release-v0.58.0.md) - systemd PTY restore polish and the desktop reconnect follow-up.
- [release-v0.59.0](release-v0.59.0.md) - the v0.59.0 feature wave: the mermaid-to-excalidraw diagram renderer, graph focus and lens fixes with an indexing placeholder, the actionable indexing dashboard, the `chan devserver --service` action-verb reshape, editor list and directory-link fixes, `cs copy`/`cs paste` clipboard bridging, a semantic-search opt-out, and chan-desktop geometry/glyph/clipboard fixes.
- [release-v0.59.1](release-v0.59.1.md) - the v0.59.0 chan-desktop known-limitation fix (excalidraw subgraphs now render everywhere), the launcher left-icon-column revert, and the remote window-title arrow glyph.
- [release-v0.60.0](release-v0.60.0.md) - the axum 0.7 to 0.8 migration across both Cargo workspaces, plus the `chan upgrade` prerelease-version fix found in the rc smoke.
- [release-v0.61.0](release-v0.61.0.md) - interactive Excalidraw whiteboard tabs and markdown slide preview, plus desktop-PWA and leader/follower session integration.
- [release-v0.62.0](release-v0.62.0.md) - the polish-and-cleanup round: no new surfaces, the existing ones done right.
- [release-v0.63.0](release-v0.63.0.md) - the Rich Prompt composer onto chan's main WYSIWYG editor, and readable, reconnectable devserver control terminals after a control-script death.
- [release-v0.64.0](release-v0.64.0.md) - the Cmd+K command launcher that lists, filters, and runs every UI action, plus trimmed tab menus and cross-machine workspace surfacing.
- [release-v0.65.0](release-v0.65.0.md) - a configurable command launcher and Settings as the one place for interactive config (per-OS shortcuts, a conditional "This workspace" tab), plus late workspace polish.
- [release-v0.66.0](release-v0.66.0.md) - the Settings overlay (focused, keyboard-navigable, focus-restoring) and consistent pane A/B side-flip rotation.
  - [release-v0.66.0-rc1](release-v0.66.0-rc1.md) - the v0.66.0 UI round validated as a pin state (Settings overlay, pane A/B flip).
- [release-v0.66.1](release-v0.66.1.md) - deterministic devserver control terminals (the daemonize handshake versus a later script exit) and unconditional Reconnect/Abandon.
  - [release-v0.66.1-rc1](release-v0.66.1-rc1.md) - rc1 fixing six post-v0.66.0 bugs (rich-prompt persistence, excalidraw View/Edit) across three file-disjoint lanes.
  - [release-v0.66.1-rc2](release-v0.66.1-rc2.md) - rc2 folding in the rc1 smoke findings: the post-connect control-terminal rule, a per-tab survey FIFO, and small fixes and UX additions.
- [release-v0.67.0](release-v0.67.0.md) - the live co-editing round (per-document server authority, named peer cursors, bannerless external merges) plus the Fedora COPR and Ubuntu Launchpad distro source-packaging work.
- [release-v0.67.1](release-v0.67.1.md) - the chan-desktop gateway OAuth handoff fix, the id.chan.app consent restyle, the `cs session self` whoami query, and a repo-wide writing-rules sweep.
  - [release-v0.67.1-rc1-handoff-and-session-self](release-v0.67.1-rc1-handoff-and-session-self.md) - the single accepted candidate branch, the gateway handoff and `cs session self` work validated as a pin state.
- [release-v0.67.2](release-v0.67.2.md) - a same-day focused patch on v0.67.1, cut straight to GA.
- [release-v0.67.3](release-v0.67.3.md) - gateway devserver windows stop reload-looping so their shells attach, and two boot-time 404s on terminal windows quieted.
- [release-v0.68.0](release-v0.68.0.md) - multiple devservers per gateway account with a sign-in picker, the one-time-code desktop sign-in handoff, Export to PDF, live-collaborative Excalidraw boards, an operator token mint, and retry-idempotent PPA publishing.
- [release-v0.69.0](release-v0.69.0.md) - gateway devserver windows made first-class (upload/download/clipboard/chords, honest post-sleep reconnect), the `cs paste` unhang with an in-window paste card, a global Open command, collapsible machine cards, and gateway registry cleanup.
- [release-v0.69.1](release-v0.69.1.md) - tunnel-mode `chan devserver --restart` under systemd (fd-preserving) and a rootless, PPA-free chan-devserver container image.
- [release-v0.70.0](release-v0.70.0.md) - first-class gateways in chan-desktop: add by URL, one account sign-in, live rosters under Computers, launcher notification bubbles, and the terminal-socket heartbeat/reconnect that keeps gateway terminals alive after idle.
- [release-v0.70.1](release-v0.70.1.md) - tunneled-devserver hardening: uploads and PDF export through the proxy, closed windows staying closed, OS logos and real names on rows, the port 8787 collision fix, and gateway rename.
- [release-v0.70.2](release-v0.70.2.md) - the terminal-reconnect regression patch (the control terminal no longer loops its connect script, an idle remote terminal keeps its process and stops leaking mouse tracking) plus table-cell inline markdown, exported-Excalidraw sizing, the slide-deck zoom_factor seed, and the page-width scrollbar position.
- [release-v0.70.3](release-v0.70.3.md) - the v0.70.2 regression patch: the editor's text-selection highlight restored under the default page-width cap, and a refused launcher Open turned into a dismissable pill instead of one stuck on the workspace forever.
- [release-v0.71.0](release-v0.71.0.md) - OpenCode as a first-class terminal agent, exact-origin desktop trust, search and graph traversal unified behind one bounded contract, and versioned `chan upgrade`; the first release cut through the team/roadmap and team/release structure.
- [release-v0.72.0](release-v0.72.0.md) - terminal write-queue batching into one agent turn, CentOS Stream COPR and Arch AUR packaging, `chan dump-skill` as an agent-facing manual, and a packaged self-upgrade refusal covering every personality.
- [release-v0.73.0](release-v0.73.0.md) - publication decoupled from the release: Docker and the distro packages fan out from their own workflows, chan stops building the CLI `.deb` and `.rpm`, and OpenCode batches its queued notifications.
- [release-v0.74.0](release-v0.74.0.md) - the distributed proxy control plane with its security hardening, deterministic `chan open` routing, a server-authoritative submit chord, devserver token rotation, editor fixes, and packaging-pipeline hardening.
- [release-v0.75.0](release-v0.75.0.md) - loopback plus PKCE desktop sign-in replacing the `chan://` scheme, the `cs pane` command surface, a per-terminal mouse-capture toggle, and editor, slides, terminal, and devserver fixes.
- [release-v0.76.0](release-v0.76.0.md) - rebuild-storm and recovery hardening: one `IndexScopePolicy`, the editor's never-discard write contract, bounded streaming transfers, a recovery-readiness surface, and safe systemd unit migration; the same-day v0.76.1 non-Linux compile patch has no report of its own.
- [release-v0.77.0](release-v0.77.0.md) - concurrency and lifecycle hardening: nonblocking reset, serialized configuration and persistence, bounded tenant shutdown, independent same-line collaboration merges, and fail-closed workspace-root loss.
- [release-v0.78.0](release-v0.78.0.md) - a deliberately narrow two-fix release: external edits that restore or shrink a file converge in the editor (the echo ring closes the v0.76.0 root cause), plus the Linux desktop clipboard fixes.
- [release-v0.79.0](release-v0.79.0.md) - the gateway administrable without database access (user access states, per-user devserver limits, revocation, an idempotent admin API), the off-macOS menubar collapse with a per-window key bridge, and ghostty-web as an opt-in terminal backend.
- [release-v0.79.1](release-v0.79.1.md) - a fix release scoped by running v0.79.0 on real machines: the Linux `cs copy` selection loss, ghostty chord and scrollbar fixes, Windows `cs` running the client again, PTYs created at the measured grid, and an honest `--submit` failure exit.
- [release-v0.79.2](release-v0.79.2.md) - nine selectable, reduced-motion-aware empty-pane animations, focus and physical-key routing fixes, and explicit SVG/PNG diagram copying with WebKit-safe Mermaid clipboard rendering.
- [release-v0.80.0](release-v0.80.0.md) - owner-gated reverse TCP tunnels to the devserver, seekable video preview over bounded HTTP ranges, exact-one-newline terminal submissions with a 4,096-byte write cap, and Ghostty/xterm behavior parity.
- [release-v0.81.0](release-v0.81.0.md) - systemd devserver terminals survive every restart flavor; media, viewer, survey-focus, and desktop Window-menu gaps close; and Nix plus Homebrew packaging join the release paths.
- [release-v0.82.0](release-v0.82.0.md) - the safety release: every HTTP read path bounded and the indexer off the workspace lock, `cs tunnel` delivering the bytes it already read, a poisoned session lock no longer aborting the process, and a switchable terminal engine.
- [release-v0.83.0](release-v0.83.0.md) - one searchable command launcher across every surface and a first extension surface, the gateway security review's remainder, terminal secret masking, Kimi as a named submit agent, and a readiness gate for the team spawn poke.
- [release-v0.83.1](release-v0.83.1.md) - the desktop renders the command deck inline instead of in a Tauri overlay window, the Computers scope resolves on desktop, and Escape releases a pending command instead of hanging the deck.
- [release-v0.83.3](release-v0.83.3.md) - the retired command-launcher overlay removed end to end (chords page-owned on every surface, `macOSPrivateApi` gone, ADR 0001 amended), and the wall-clock timing tests made load-proof; v0.83.2 skipped.
- [release-v0.83.4](release-v0.83.4.md) - a fix release scoped by running v0.83.3 on real hardware: gateway-served desktop windows can mutate again, windows settle across a remote reboot, terminal reattach drops from over 180 s to 2.8 s, and keyboard paste is repaired.
- [release-v0.84.0](release-v0.84.0.md) - appearance controls, server-settled terminal metadata, opt-in secret masking, browser-native audio, a Rich Prompt control strip, Hybrid Nav collaboration safety, and Ubuntu sdme checks for the Windows and Nix release builds.
- [release-v0.84.1](release-v0.84.1.md) - a same-day patch from using v0.84.0: the idle graph stops repainting, BM25 drops tombstoned paths (the v0.84.0 tag-run failure), a pane split survives mid-teardown layout reads, and refused desktop windows say why.
- [release-v0.85.0](release-v0.85.0.md) - the large-transfer release: the compiled-in 50 MiB write limit replaced by a configured ceiling on a process-wide admission lane, terminal downloads bounded by it, native library windows on desktop, Hybrid Nav mouse splits, and ghostty column-erase fixes.
- [release-v0.86.0](release-v0.86.0.md) - extensions finally boot through the gateway (the cookieless iframe path admitted, CORS-readable errors, tabs converging across restarts), `cs terminal new` and `restart` carrying `--command`/`--env`, desktop build identity, and archive ceiling bounds on both arms.
- [release-v0.87.0](release-v0.87.0.md) - the flaky scene test that was a production data-loss path: the mtime-only write CAS now verifies bytes; plus the watcher-reconcile driver, desktop authorization landing on the profile page, and a runtime devserver build id.
- [release-v0.88.0](release-v0.88.0.md) - the browser smokes, runnable in the project's containers for the first time, immediately found a real stale-read defect; plus `chan ps` answering what a workspace is doing, the boot overlay no longer locking a healthy rebuild, and a publish=false dry run on the tagged run's code path.
- [release-v0.89.0](release-v0.89.0.md) - rebindable deck chords, a configurable graph palette, Settings by concern, ghostty as the Linux desktop default, agy as a submit agent, and a load-sensitive test diagnosed to a process-global injection slot; a second team finished the round after infrastructure killed the first.
- [release-v0.90.0](release-v0.90.0.md) - the Windows execution release: server-spawned Windows terminals unwedged from ConPTY's own startup handshake, the workspace lock's holder record readable while held, chan.exe executed by CI for the first time, and AppImage terminals keeping the bundle environment out; writing the CI smoke surfaced two of the three fixes.
- [release-v0.91.0](release-v0.91.0.md) - a standalone window that browses and edits the machine's files, Windows shell profiles with a picker, cross-window tab drag that stops turning tabs into terminals, and AUR publication restored; four candidates, and everything after the first came from the owner testing them rather than from review.

- [release-v0.92.0](release-v0.92.0.md) - the gateway's canonical design written against the running code, workspace terminals surviving a devserver restart, and an intermittent stale read that closed as correct behaviour; a pre-registered threshold overturned the lead's own first conclusion about a flaky check.

- [release-v0.93.0](release-v0.93.0.md) - one filesystem namespace reachable from every window, the Linux desktop AppImage following its own driver decision for the terminal renderer, and a fork-inheritance mechanism found for a load-sensitive test nobody had explained; a lane caught a shipping blocker inside its own change that the lead had already cleared, and the release pipeline caught a defect the local gate had been configured not to see.
- [release-v0.94.0](release-v0.94.0.md) - an integration round: the CLI's noun-family grammar, drafts and Rich Prompt in standalone windows, gateway operator PAT mint/revoke through the app layer, the extensions front-door guide, the `/api/files` removal on its documented deadline, and the tunnel namespace renamed to `proxy.{domain}`; the gate burned down five reds the round's own sweeps could not see, and the expensive mistakes were all verdict-handling, not code.

## Conventions

Agent references in prose use plain names for people and lanes; the `@@` sigil is reserved for the five reusable skill identities (`@@architect`, `@@fabler`, `@@rustacean`, `@@syseng`, `@@webdev`) plus the generic `@@agent` for an unidentifiable past skill. A historical lane named for a discipline (Architect, Syseng, Rustacean, Web/Frontend) is rendered as its skill sigil (`@@architect`, `@@syseng`, `@@rustacean`, `@@webdev`) even where it sits among plain lane names; reused or suffixed slots (FrontendB, WebMain, FullStackA) stay plain. The coordination scheme evolved over the project; each report records the scheme that era ran on, and the cross-project summary is in [`.agents/playbook.md`](../../.agents/playbook.md). Reports are text only; a load-bearing screenshot is described in prose rather than embedded.
