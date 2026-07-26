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
- [release-v0.71.0](release-v0.71.0.md) - OpenCode as a first-class terminal agent, authenticated exact-origin desktop trust replacing the static wildcard grant, workspace search and graph traversal unified behind one bounded contract and one agent tool, `chan upgrade --version` resolving the last five GA releases, and two editor cosmetics; the first release cut through the team/roadmap + team/release structure.
- [release-v0.72.0](release-v0.72.0.md) - terminal write-queue batching into one agent turn, CentOS Stream COPR and Arch AUR packaging, `chan dump-skill` as an agent-facing manual of the whole surface, and a packaged self-upgrade refusal that covers every personality.
- [release-v0.73.0](release-v0.73.0.md) - publication decoupled from the release: Docker and every distro package fan out in parallel from their own workflow and can no longer hold up a release or block each other; chan stops building the CLI `.deb` and `.rpm` the distributions now build; OpenCode batches its queued terminal notifications; the Command Launcher's dead "Flip pane" row works. The distributed proxy control plane was deferred again.
- [release-v0.74.0](release-v0.74.0.md) - the distributed proxy control plane lands with its security hardening and the `__Host-` cookie rename; plus deterministic `chan open` routing across local instances, a server-authoritative submit chord, devserver token rotation, a batch of editor fixes, and packaging-pipeline hardening (advisory AUR publish check, a COPR provenance probe, aarch64 AUR CI removed).
- [release-v0.75.0](release-v0.75.0.md) - loopback + PKCE desktop sign-in replacing the `chan://` scheme (fixing Linux/Windows sign-in and closing the deep-link second-instance gap), a consistent `cs pane` command surface for addressing windows/panes/Hybrid sides, a per-terminal mouse-capture toggle, survey `[F]` reduced to a bare signal, dropping the self-built desktop `.deb`/`.rpm`, and a round of editor/slides/terminal/devserver bug fixes.
- [release-v0.76.0](release-v0.76.0.md) - rebuild-storm and recovery hardening: one `IndexScopePolicy` across walk/index/watch/report with `.gitignore` honoring and a rebuild generation coordinator; the editor's never-discard write contract (`428`/`409` + reachable conflict resolution) and session-restart durability that stops a restart flushing stale authority; bounded streaming transfers on desktop and the terminal download; a workspace recovery-readiness surface on the status routes, the SPA, and `chan workspace status`; and safe systemd unit classification/migration. A plan-driven team round hardened behind two adversarial review passes and prepared as a local unpushed cycle.
- [release-v0.77.0](release-v0.77.0.md) - concurrency and lifecycle hardening: nonblocking reset, serialized configuration and persistence, bounded tenant shutdown, independent same-line collaboration merges, fail-closed workspace-root loss with end-to-end coverage, and ordinary native, distro, and container build gates.
- [release-v0.78.0](release-v0.78.0.md) - a deliberately narrow two-fix release: external filesystem edits that restore or shrink a file now converge in the editor (the echo ring distinguishes bytes chan wrote from bytes it read, closing the root cause v0.76.0 had only bounded to 60s), plus the Linux desktop clipboard fixes (operations off the invoke thread, a process-wide handle so a copy survives, and generated systemd/launchd supervisors that keep the `chan` entry point instead of launching the GUI). Video preview, the ghostty backend, and the DOOM overlay were held for v0.79.0.

- [release-v0.79.0](release-v0.79.0.md) - the gateway becomes administrable as a product boundary without database access (explicit user access states, a fleet-wide per-user devserver limit, session and tunnel revocation, an idempotent admin API, credentials separated from database roles); off macOS the native menubar collapses to the launcher window alone with its chords moved into a per-window key bridge; ghostty-web ships as an opt-in default-off terminal backend; tab rotation covers both Hybrid sides and the empty-pane close flips instead of only flashing; and two classes of load-sensitive false-red test are removed.

## Conventions

Agent references in prose use plain names for people and lanes; the `@@` sigil is reserved for the five reusable skill identities (`@@architect`, `@@fabler`, `@@rustacean`, `@@syseng`, `@@webdev`) plus the generic `@@agent` for an unidentifiable past skill. A historical lane named for a discipline (Architect, Syseng, Rustacean, Web/Frontend) is rendered as its skill sigil (`@@architect`, `@@syseng`, `@@rustacean`, `@@webdev`) even where it sits among plain lane names; reused or suffixed slots (FrontendB, WebMain, FullStackA) stay plain. The coordination scheme evolved over the project; each report records the scheme that era ran on, and the cross-project summary is in [`.agents/playbook.md`](../../.agents/playbook.md). Reports are text only; a load-bearing screenshot is described in prose rather than embedded.
