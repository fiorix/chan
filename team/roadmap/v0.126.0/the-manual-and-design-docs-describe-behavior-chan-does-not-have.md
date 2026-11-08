# The manual and design docs describe behavior chan does not have

Status: raised on 2026-11-08 while writing the chan.app tutorials; accepted by the owner for v0.126.0; not started.

## What is there now

Reading the code behind each tutorial step found these statements that the product contradicts:

1. `web/packages/marketing/src/pages/manual/navigation.html:56` says the command launcher's Computers scope shows a `tmux -CC` connection "as a card of its own there, with its windows and its detach and end". Neither command launcher has tmux detach or end (`web/packages/workspace-app/src/components/CommandLauncher.svelte` has no tmux code; `web/packages/launcher/src/components/CommandLauncher.svelte:121-128` names a tmux window's machine only). They live on the Computers screen's card, its selection bar and the desktop's close prompt.
2. The manual's tmux section (`manual/terminal.html:128-136`) says each tmux window opens as a chan window of its own. That holds on the desktop; in a browser nothing opens by itself, and each window is opened from the card. The section also omits the card title of a devserver's tmux, `tmux -CC on` and the devserver's name (`web/packages/launcher/src/lib/machineTree.ts:107`).
3. `manual/terminal.html:130` and `docs/config-reference.md:32` name mosh as a program that can carry a remote `tmux -CC`, and the trust setting's error text suggests `["ssh","mosh-client"]` (`crates/chan/src/config.rs:699`). mosh redraws the screen from its own state instead of relaying the remote's bytes, and iTerm2 documents that its tmux integration does not work over mosh; no chan run over mosh is on record.
4. The chan.app gateway page (`web/packages/marketing/src/pages/gateway.html:65`) and `manual/devserver.html:90` say a gateway's WireGuard file takes effect after restarting Chan Desktop. The Add/Edit gateway form says it takes effect as soon as it is saved (`web/packages/launcher/src/components/GatewayForm.svelte:220`), and so does `desktop/design.md:232`.
5. `manual/devserver.html` does not mention `chan devserver rotate-token`.
6. `desktop/design.md:190-207`, the devserver connect prose and its sequence diagram, has the desktop open a terminal on connect and tuck the control terminal away. The desktop opens no terminal on connect (the devserver's first-open rule does), and the control terminal stays open unless the devserver's "Auto-hide control terminal on success" is set (`desktop/src-tauri/src/main.rs:2658-2675`).
7. The account SPA's Copy link comment says the link is safe to hand to a grantee (`web/packages/profile/src/views/Devservers.svelte:165-167`). The link is the whole-devserver `/s/{owner}?d=` form, which admits the owner alone (`gateway/crates/identity/src/http.rs:1592`), so a grantee gets not-found.
8. `gateway/crates/profile/packaging/profile.env:30` says the sweeper's deleted rows take their grants with them; the sweeper deletes no row that has a grant (`gateway/crates/profile/src/sweeper.rs:86-92`).
9. `gateway/crates/profile/design.md:152` ends with "identity renames on first sign-in."; the sign-in callback passes no handle to the profile upsert and renames nothing (`gateway/crates/identity/src/http.rs:523-533`).
10. `.github/workflows/release.yml:442` says the gateway ships five .deb packages; `make gateway-release-crates` lists six.

## Desired contract

1. Each statement above matches the product, by changing its text.
2. Item 3 is settled by a run of `tmux -CC` over mosh: mosh stays in the manual, the config reference and the error text only if the run attaches.
3. Item 7 is settled by an owner decision on whether a grantee can use a whole-devserver link; a decision that changes code becomes a row of its own, and this item changes the comment and the button's wording to match.

## Boundaries

- Text only: the manual pages, the chan.app gateway page, `desktop/design.md`, the config reference and the trust error text, the profile env template and design doc, the release workflow comment, and the Copy link comment and label.

## Acceptance

1. Each numbered statement read against the code at the tip, with the reading recorded in this item when it closes.
2. The mosh run recorded beside item 3's change.
3. `npm run check` in `web/packages/marketing` and `make workflow-check` green.
