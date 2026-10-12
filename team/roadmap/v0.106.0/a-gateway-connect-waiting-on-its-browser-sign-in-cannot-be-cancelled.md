# A gateway connect waiting on its browser sign-in cannot be cancelled

Status: raised by the owner on 2026-10-12 from the launcher; written down with a source reading, not reproduced by a team, not designed. The owner stated the contract wanted and, asked the same day whether it goes to the team or is fixed before the launch, answered "as recommended" (see "Owner's decision"). Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction named below) is accepted, and nothing past the decision it names.

## What was seen

The owner's words: "when you register a gateway and it is disconnected, you can click to connect and it'll open a page in a browser for the oauth workflow.. however, if you close that page the client gets stuck spinning waiting for the oauth and there's no way to cancel it.. what i want is that whenever the connect button is spinning, we should be able to click to interrupt the connection at any point in time, and stop the workflow entirely; it shoudl then print the connect button again so that we could start the entire flow again".

Read at source on `main` at `4507fe5a0`:

- When a connect hands off to the browser, the desktop sets the gateway's runtime to `pending_signin = true` and `status = GatewayStatus::Connecting` together (`desktop/src-tauri/src/gateway.rs`, the block after `auth::open_gateway_signin`, about line 951), and expires the wait only after `GATEWAY_SIGNIN_TIMEOUT`, five minutes (`desktop/src-tauri/src/main.rs`, line 2080), or on a consumed callback: a successful one resumes the connect (`resume_gateway_signin`), a failed one resets every parked wait (`abandon_pending_signins`, called only from `auth.rs` `settle` on a failed redeem, a failed PAT store or an error callback). No competing sign-in ends a parked wait at this base: a sign-in for another gateway is refused by the busy gate before it opens, a re-click on the same gateway re-parks the same runtime with a new stamp, and the module header's sentence that a competing sign-in replacing the slot settles every parked wait has no call site behind it (read by the review seat on 2026-10-12).
- The gateway card tests `status === "connecting"` first and renders a disabled button titled "Working..." (`web/packages/launcher/src/components/Gateways.svelte`, `spinning`, the first branch of the control). The live button that the comment below it describes ("While a browser sign-in is pending the button stays live: a re-click re-opens the sign-in page") is in the last branch, which a `connecting` gateway never reaches.
- The card's test for the pending wait builds its gateway with `pending_signin: true` and the fixture's default `status: "disconnected"` (`Gateways.test.ts`, "a pending sign-in narrates the browser wait and keeps the re-open affordance"), a pair the desktop does not produce. The test is green on a state the product never shows.
- The module's own header calls the re-click "the user's retry hatch". By this reading the hatch is closed for the whole five minutes.
- A user disconnect removes the gateway's runtime and cancels its roster poll (`gateway.rs`, the disconnect cascade), which would end the wait, but the card offers Disconnect only for `connected` and `unreachable`.

Not established: the reading was not run in a desktop build. Whether the devserver card in `Library.svelte`, which has the same `pending_signin` narration and keeps its row `Disconnected` during the wait by its comment, has the same fault or not. Whether the process-global pending-auth slot in `desktop/src-tauri/src/auth.rs` must be cleared by a cancel, so that a late callback from the closed tab's flow is refused and not resumed. What a cancel during discovery or during the first roster fetch (no browser involved) leaves behind.

## Desired contract

The owner's: whenever the connect control is spinning, a click interrupts the connection at any point and stops the workflow entirely; the card then shows Connect again and the whole flow can be started again.

Read as: every state in which the card shows work in flight (discovery, the browser sign-in wait, the resume after the callback, the first roster fetch) offers one live cancel control. A cancel ends the attempt desktop-side: the wait and any in-flight request of that attempt are dropped, no late callback or late response of the cancelled attempt connects the gateway or changes its row, and the gateway reads `disconnected` with no error notice for the user's own cancel. A new Connect after it starts a fresh flow, opening the browser again when a sign-in is needed.

## What to do

Reproduce first in a desktop build in a guest: connect a gateway that needs a sign-in, close the browser page, and record the card's control, its status and the time until it recovers. Then design, to the reviewer before code: what the cancel is on the wire (the existing disconnect, or a request of its own, given that disconnect persists `enabled = false`, which is the right end state for a cancel or is not); how the attempt is identified so that a late callback or response of a cancelled attempt is refused (the runtime already carries `signin_stamp`); what happens to the single pending-auth slot; and whether the spinner itself is the cancel control or a control beside it. Settle whether the devserver card gets the same control in this item. Correct the card's test fixture to the pair the desktop produces.

## Boundaries

`desktop/src-tauri/src/gateway.rs` (the connect, the sign-in wait, the resume, the cascade), `desktop/src-tauri/src/auth.rs` (the pending slot) and their tests; `web/packages/launcher/src/components/Gateways.svelte` and `Gateways.test.ts`; `web/packages/launcher/src/api/library.ts` and its mock and demo if a request is added; `Library.svelte` and `LibraryGatewayRows.test.ts` if the devserver card is in. Not changed: the sign-in's single-flight rule across gateways, the roster poll's failure rules, the stored token's handling.

## Acceptance

1. The fault reproduced in a desktop build, with the control's state and the time to recovery recorded.
2. In each in-flight state the card shows a live cancel control, proved by component tests built on the status and `pending_signin` pairs the desktop produces, the present disabled-spinner test replaced.
3. A cancel during the browser wait returns the card to Connect at once, and a callback from the cancelled flow arriving afterwards does not connect the gateway, proved by a desktop test that is red before the repair on its own assertion.
4. A cancel during discovery and during the first roster fetch leaves no runtime, no poll and no later row change from that attempt.
5. Connect after a cancel runs the whole flow again, the browser opened anew.
6. The owner's own cancel raises no error notice; a timeout still does.
7. One native run on Linux WebKitGTK of the owner's steps, with the engine named; macOS and Windows are stated as not observed unless the owner takes a reading.

## Owner's decision 2026-10-12

Put to the owner on 2026-10-12 at the v0.106 kickoff: hand it to the team as the Desktop seat's first item, or have the preparer fix it before the launch. The recommendation put to him was the team, first in the Desktop lane, since it spans the desktop crate and the launcher and its proof needs a desktop build and a native run in a guest. The owner's answer, in his words: "as recommended". Applied as: Desktop106's first item; the reproduction first, then the design to the reviewer before code; the launcher's `Gateways.svelte` and `Gateways.test.ts` are the Desktop seat's to write for this item.
