# No printed line opens the devserver in a browser

Status: raised by the owner on 2026-10-03, from use, while opening a running devserver in a browser to work around [a-slide-decks-pdf-lacks-the-images-it-shows](a-slide-decks-pdf-lacks-the-images-it-shows.md). Read in code at `13cf4e175`; `chan devserver status` was run against the owner's running devserver and its output is quoted below. The masking reading was not run.

## Owner ruling

Accepted on 2026-10-03 for v0.102.0 on the owner's word "new roadmap item". The shape of the fix is not ruled; the exposure question under "What to do" is open.

## What was seen

The owner's words: "chan devserver status does not print the url or the token; it should print the full URL"; "the control terminal which does print the token that we scrape, does not print the URL - and it should, because users should be able to just click it to open the same devserver in a browser"; "only the control terminal should have the secret masking ON by default".

**`status` prints no address.** Against the owner's running devserver, `chan devserver status` printed its backend and the unit's command, and nothing a person can open:

```
chan devserver (systemd): running -- chan-devserver.service
  command: /home/.../.local/bin/chan devserver run --bind=127.0.0.1 --port=18001
```

The systemd arm prints that pair at `crates/chan/src/devserver.rs:438`; the chan-managed arm prints pid, bind and start time at `crates/chan/src/devserver_daemon.rs:200`. Neither prints the token or the launch URL. `rotate-token` does print one, `chan devserver: listening on http://{addr}/?t={token}` (`crates/chan/src/devserver/management.rs:158-166`), and `serve_config.rs:83` is the single place that builds it. So the line exists, and only the verbs that do not mint a token lack it.

**The control terminal prints the token and not the URL.** A desktop control terminal's scrollback carries the `CHAN_DEVSERVER_TOKEN=` marker, and that scrollback is the desktop's only distribution channel for it: the desktop re-scrapes the marker on every connect (`crates/chan/src/devserver/management.rs:160`, `:341`; `web/packages/workspace-app/src/state/windowMode.ts:73-76`). A person who wants that same devserver in a browser has to join the marker to the address themselves.

**Masking is one switch for every terminal.** `terminal.secret_masking` is a single preference, xterm-only and off by default (`crates/chan-library/src/config.rs:108-116`, `:252`; `crates/chan-server/src/config.rs:184`), read once per terminal tab (`web/packages/workspace-app/src/components/TerminalTab.svelte:971`). Nothing defaults it per terminal kind. The control terminal, the one surface guaranteed to print a bearer token, is therefore unmasked unless the user turns masking on for every terminal in the window.

## Desired contract

`chan devserver status` prints the full launch URL of a running devserver, token included, in both the systemd and the chan-managed arms, in the shape `rotate-token` already prints and from the same builder. The desktop's control terminal prints that URL beside the token it already prints, so a person opens the same devserver in a browser from the line in front of them rather than assembling it. Secret masking defaults on in a control terminal and off in every other terminal; an explicit user preference still decides where it is set, in either direction.

## What to do

Reuse `ServeHandle::launch_url` rather than formatting a second URL; the shape printed on rotation is the one to print. Decide, and record, what `status` does when it cannot read the token: the systemd arm reads the unit, not the devserver's state, and a caller outside the `systemd-journal`/`adm` groups cannot scrape the journal (`crates/chan/src/devserver/management.rs:201`), so `status` has to name the missing token rather than print a URL that will not authenticate.

Rule the exposure before printing: a URL with a bearer in it lands wherever `status` output lands, including shell history, CI logs and pasted terminal captures, and today the token reaches those places only when a person asks for it by rotating. The masking default is the counterweight on the one surface chan itself prints it to, and it does not cover a pipe. Masking is a render-time decision in the frontend, so defaulting it on in a control terminal does not change what the desktop scrapes.

## Boundaries

`crates/chan/src/devserver.rs`, `crates/chan/src/devserver_daemon.rs` and `crates/chan/src/devserver/management.rs` for the printed lines; `crates/chan-library/src/serve_config.rs` for the URL builder, which is reused and not changed; `web/packages/workspace-app/src/components/TerminalTab.svelte` and `crates/chan-library/src/config.rs` for the masking default, and `web/packages/workspace-app/src/state/windowMode.ts` if the control-terminal sub-mode is what carries it; the help text of the affected verbs in `crates/chan/src/help.rs` and `crates/chan/src/cli.rs`; and their tests. The marker the desktop scrapes keeps its exact current spelling and position, since an older desktop scrapes a newer devserver. The default of `terminal.secret_masking` outside a control terminal stays off.

## Acceptance

1. `chan devserver status` against a running devserver prints the same launch URL `rotate-token` prints, from `launch_url`, in the systemd arm and the chan-managed arm; pinned in both, red first.
2. `status` against a running devserver whose token it cannot read prints the state and names the missing token, and prints no URL; pinned.
3. A control terminal's scrollback carries the launch URL beside the `CHAN_DEVSERVER_TOKEN=` marker, and the desktop's scrape of that marker is unchanged by the added line; pinned on the scrape.
4. A terminal tab in a control terminal starts with masking on, and a terminal tab in any other window starts with it off, with `terminal.secret_masking` unset; pinned. An explicit `secret_masking = true` or `false` wins in both; pinned.
5. On a display, by a person: `chan devserver status` on the owner's VM, the printed URL opened in a browser, and the same URL read off the desktop's control terminal.
