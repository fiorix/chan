# The public surfaces say chan serve where chan open is the command to open a workspace

Status: shipped at [v0.112.0](../../release/release-v0.112.0.md); the section Closing evidence holds the evidence.

Record before the release: raised on 2026-10-26 by the owner at the v0.111.0 close; awaiting acceptance for v0.112.0.

## What was seen

The owner's words of 2026-10-26, after the v0.111.0 release: "the public website still uses `chan serve` instead of `chan open` for public documentation", quoting the launcher's empty state: "No workspaces yet. Add one with the buttons above, or run chan serve /path/to/project in a terminal."

Read at `e12f66154`, the v0.111.0 publication record on `main`. Paths under `web/packages/` unless named.

- `launcher/src/components/Library.svelte` lines 414 to 417: the local machine's empty hint reads "No workspaces yet. Add one with the buttons above, or run `chan serve /path/to/project` in a terminal." The launcher is served at every devserver and gateway root and as the live widget on the chan.app manual, so this sentence is public; the read-only variant above it names the CLI without a command, and the devserver variant below it spells `chan workspace serve /path/on/that/machine --on NAME`.
- `marketing/src/pages/manual/install.html` lines 50 and 51: "`chan open` is an alias for `chan serve`", then "`chan serve {path}` works anywhere chan runs: in a local terminal it registers the workspace on this machine (the same thing the New workspace button does), and in a devserver terminal it registers the workspace on that devserver".
- `marketing/src/pages/manual/devserver.html` line 74: "run `chan serve {path}` in a devserver terminal to create a workspace on that machine, or `chan workspace serve {path} --on NAME`".
- `manual/terminal.html` and the CLI help already say `chan open` (the `chan` crate's help pins both `chan open` and `cs open`); `.agents/patterns.md` keeps `serve` and `close` as the family verbs with top-level spellings and `chan open` as the open verb.

## Desired contract

Every public sentence that tells a reader how to open a workspace from a terminal names `chan open PATH`: the launcher's local empty hint, the manual's install page (with `chan serve` presented as the serving verb that `chan open` stands on, not the other way round) and the manual's devserver page for the "in a devserver terminal" case. `chan workspace serve PATH --on NAME` stays as the remote spelling, and `chan serve` keeps its own documentation wherever standalone serving is meant. The launcher's test for the empty hint pins the new sentence.

## What to do

1. `launcher/src/components/Library.svelte`: the local empty hint runs `chan open /path/to/project`; its test (`Library.test.ts` or the deck test that renders the empty local machine) asserts the sentence.
2. `marketing/src/pages/manual/install.html`: lead with `chan open {path}` and describe `chan serve` as the serving verb it is an alias of; `manual/devserver.html` line 74 likewise for the devserver terminal.
3. A grep of `web/packages/marketing/src`, `web/packages/launcher/src`, `docs/` and `README.md` for `chan serve` as the opening command, each remaining mention justified as serving.

## Boundaries

`web/packages/launcher/src/components/Library.svelte` and its test, `web/packages/marketing/src/pages/manual/install.html` and `devserver.html`. Not changed: the CLI's verbs, help and aliases; `cs open`; the devserver variant's `chan workspace serve --on` spelling; `docs/contributing/` pages, which describe serving.

## Acceptance

1. The launcher's local empty state, served at a devserver root and on the chan.app manual, names `chan open /path/to/project`, and its test pins the sentence.
2. The manual's install and devserver pages name `chan open` as the command to open a workspace and keep `chan serve` where serving is meant; `make web-check` and `make web-marketing-check` green.

## Closing evidence

The mutable local machine's empty hint names `chan open /path/to/project`; a mounted Library test pins the full sentence. The install page leads with `chan open` and describes `chan serve` as the command that registers and serves the workspace behind that alias. The devserver terminal case names `chan open {path}`, while the remote command stays `chan workspace serve {path} --on NAME`. The read-only and devserver empty hints are unchanged.

The new test failed on the rendered `chan serve /path/to/project` sentence before the copy changed (`dev/v0112-team/evidence/Web112/chopen-local-hint-red.log`, exit 1, one assertion failed), then passed with the new sentence (`chopen-local-hint-green.log`, exit 0, one test passed). The dialog tip assertion also failed first on rendered `chan serve <path>` (`chopen-dialog-red.log`, exit 1), then passed with `chan open <path>` (`chopen-dialog-green.log`, exit 0). `make web-check` passed (`chopen-web-check.log`, exit 0): the launcher bundle is 57.0 KiB gzipped against 60 KiB, all four Svelte checks have no diagnostics, and Vitest passed 218 web-shared, 660 launcher, 7,762 workspace app and 20 profile tests. The first `make web-marketing-check` reached the dist smoke after the build and eight passing tests, then failed when the default sandbox refused a loopback bind with `EPERM` (`chopen-web-marketing-check.log`, exit 2). The unchanged command with loopback access passed, including the dist route and installer smokes (`chopen-web-marketing-check-loopback.log`, exit 0). The built install and devserver HTML both contain `chan open {path}`.

The lead widened this row's edit boundary by review ruling to include the New workspace dialog tip, its test and the demo comment. The dialog now says `chan open <path>` to add a workspace, its test pins the tip, and the demo comment describes the manual's first-workspace walkthrough without a command.

The sweep `rg -n -F 'chan serve' web/packages/marketing/src web/packages/launcher/src docs README.md` found five remaining lines. Each describes serving:

- `docs/contributing/linux-and-macos.md:147` has a live `chan serve` process in the container.
- `docs/contributing/linux-and-macos.md:154` discusses the path served by `chan serve .` during AppImage testing.
- `docs/contributing/linux-and-macos.md:191` names the discovery socket used by `chan serve PATH` to register with a devserver.
- `web/packages/marketing/src/pages/manual/install.html:50` identifies `chan serve` as the command that registers and serves behind the opening alias.
- `web/packages/launcher/src/state/library.svelte.ts:102` names workspace mount and unmount feed events caused by serving.

These five opening or adding mentions from the initial sweep are changed in this range under the lead's ruling:

- `web/packages/launcher/src/components/NewWorkspaceDialog.test.ts:61` names the `chan open` tip.
- `web/packages/launcher/src/components/NewWorkspaceDialog.test.ts:69` pins `chan open <path>` in that tip.
- `web/packages/launcher/src/components/NewWorkspaceDialog.svelte:137` tells the reader to use `chan open <path>` to add a workspace.
- `web/packages/launcher/src/components/NewWorkspaceDialog.svelte:224` names `chan open` in the shell-action comment.
- `web/packages/launcher/src/api/demo.ts:590` describes the first-workspace walkthrough without a command name.
