# Program status

These end-to-end scenarios drive OSC 7501 through a real terminal and compare the tab strip, `cs terminal list`, and the page's socket under xterm.js and ghostty-web. Each browser check keeps its subject tab out of the front except when a leg explicitly focuses it. Checks 140 to 161 provide the browser backing named below.

Run one check with its exact filename prefix, for example `SMOKE_ONLY=140- node scripts/e2e/browser-smoke/run.mjs`, and run the full suite after integration. These checks require the server's program-status frames and list field.

## Scenarios

### PS-01 - nothing reported

**Expectation.** Output lights the ordinary dot; the leading place remains the terminal icon; the list has an empty status set and a `-` program cell. **Backing.** `140-program-unreported.mjs`. **Mutations.** Suppress the dot; replace the icon; insert a record in the empty session/list snapshot; change the empty cell.

### PS-02 - working

**Expectation.** A working report draws the spinner, suppresses the dot despite later output, and appears as working in the cell, JSON and socket frame. **Backing.** `141-program-working.mjs`. **Mutations.** Suppress the spinner; leave the dot; omit the JSON record; change the cell; omit the frame.

### PS-03 - progress

**Expectation.** A root working report with progress 40 draws a ring whose actual `stroke-dasharray` is `40 100`; the list says `working 40%`, and JSON and frame carry 40. **Backing.** `142-program-progress.mjs`. **Mutations.** Replace the ring; change its drawing value while retaining the label; drop 40 from the cell, JSON or frame.

### PS-04 - blocked kinds

**Expectation.** Permission, question, auth and no kind produce four distinct trailing shapes and labels, with matching cell, JSON and frame values. **Backing.** `143-program-blocked.mjs`. **Mutations.** Reuse a shape; swap a label; omit or change one kind in the cell, JSON or frame.

### PS-05 - completion and acknowledgment

**Expectation.** Done and error show behind the front tab; focusing the subject hides the mark, retains the record and marks it seen in JSON; a done arriving while front starts seen. **Backing.** `144-program-completion.mjs`. **Mutations.** Remove either shape; hide without a focus word; delete the seen record; premark a background completion; briefly paint the in-front done mark.

### PS-06 - idle

**Expectation.** Idle has no program mark and appears as idle in the cell, JSON and frame; the ordinary output dot remains independent. **Backing.** `145-program-idle.mjs`. **Mutations.** Draw a program mark; change the cell; omit idle from JSON or frame; suppress the independent dot.

### PS-07 - working parent and blocked child

**Expectation.** A working root and blocked child show both places, with the child's tooltip and inspector inheriting its nearest same-source ancestor app. **Backing.** `146-program-parent-child.mjs`. **Mutations.** Let either mark suppress the other; omit app inheritance; inherit across sources.

### PS-08 - clear and reset isolation

**Expectation.** Clearing an id, clearing all and `ESC c` produce the exact expected sets from root, `a`, `a/b`, `ab` and a parked chan-owned survey. The survey stays blocked in JSON, the socket, the strip and the list cell until answered. **Backing.** `147-program-clear.mjs`. **Mutations.** Clear by prefix; retain a program record after clear-all or reset; delete the chan-owned record; reorder survivors.

### PS-09 - tooltip and inspector

**Expectation.** The tooltip and keyboard-reachable inspector show app, title and msg under the tab name; the inspector lists source, id and state for the record, while JSON pins update order. **Backing.** `148-program-inspector.mjs`. **Mutations.** Drop a field; resolve app against the wrong ancestor; reorder the list; remove keyboard access.

### PS-10 - query and engine control

**Expectation.** A raw-mode PTY program receives one 7501 answer with the query's BEL or ST terminator before the engine's answer to `CSI c`; the engine itself emits no 7501 reply. **Backing.** `149-program-query.mjs`, with separate stage 3 engine guard unit and constructed-page legs. **Mutations.** Suppress the library answer; force one terminator; reverse reply order; remove the `CSI c` control; install an answering engine handler and remove its guard.

### PS-11 - attach, reload, move and restart

**Expectation.** A second page on the same session, a reload and a moved tab receive the current set at attach; an in-place terminal restart starts empty. **Backing.** `150-program-attach.mjs`. **Mutations.** Omit status at any attach; carry a stale tab field through reload or move; retain the old incarnation on restart.

### PS-12 - chan commands

**Expectation.** A subject-origin survey is blocked until answered in the page; export is working while its page is held; `cs terminal status` sends each state and refuses over-limit input with the set unchanged. **Backing.** `151-program-commands.mjs` holds the survey until a browser answer and the export at its upload request, drives every CLI state from a held foreground script, and compares the whole snapshot after an over-limit refusal. **Mutations.** Omit or leak the survey lease; omit or prematurely release export; skip an emitter state; admit an over-limit body.

### PS-13 - exit

**Expectation.** A session-owned process emits done and exits immediately after attach; its background attached tab retains the check beside `process exited`. **Backing.** `152-program-exit.mjs` holds the process behind an attach release, asserts the final status and exit frames beside the background check, then captures the exit message after focus. **Mutations.** Omit the final status frame; clear done on exit; hide the unseen check when the process exits.

### PS-14 - foreground cleanup

**Expectation.** Working and blocked marks disappear after SIGKILL, Ctrl-C and silent exit; a stopped job retains working; done survives; a second sequential job is untouched by the first's end; a background report made under another foreground job goes with that job. **Backing.** `153-program-foreground.mjs` drives a shell with job control and no prompt mark, observes the child process groups, and asserts each record set and strip mark. **Mutations.** Remove foreground-group drop for each ended-job leg; apply it to a stopped job or done; attach the second job to the first group; preserve the background report past the owner's end.

### PS-15 - request lifetime

**Expectation.** Killing the `cs` that holds a visible survey removes it from strip and JSON; a survey timeout also leaves none. **Backing.** `154-program-lease.mjs` captures the subject shell's survey PID, kills it after the mark is visible, and waits on the timeout command's exit marker. **Mutations.** Remove cleanup on task drop or timeout; hide only the strip mark while retaining JSON.

### PS-16 - paced flood

**Expectation.** Maximum-size alternating reports do not stop ordinary output, end at the last state, and yield no more socket frames than the pace interval plus the attach allowance. **Backing.** `155-program-flood.mjs`. **Mutations.** Remove the pace; publish an earlier captured value; block output on publication; drop the final report.

### PS-17 - malformed reports and cap

**Expectation.** Each overlong, bad-base64, control-bearing, invalid-UTF-8, invalid-id, unknown-state and limit-breaking-clear input leaves the full set, revision and order unchanged; a clear carrying a merely malformed pair skips that pair and clears the named subtree; a later valid report applies; 300 distinct records respect the 64-record cap and evict by last update. **Backing.** `156-program-invalid.mjs`. **Mutations.** Remove each limit or grammar guard; apply a partial malformed report; increment revision on discard; evict by creation order; ignore the cap or the recovery report.

### PS-18 - hostile text

**Expectation.** HTML with a handler, a right-to-left override and a zero-width character in program msg/title and survey title render as disarmed text in tooltip and inspector, create no element, and enter no list cell. **Backing.** `157-program-text.mjs` covers program title and msg plus a held subject-origin survey title in the tooltip, inspector, overlay and list. **Mutations.** Render as HTML; leave either formatting code point undisarmed; put free text in the list; omit survey-title sanitization.

### PS-19 - framing cuts

**Expectation.** An unterminated body changes nothing until completion; CAN aborts without swallowing the next report; an ESC ending a report starts a harmless sequence; `ESC c` clears the record. **Backing.** `158-program-framing.mjs`. **Mutations.** Apply a prefix early; accept CAN as a terminator; swallow the ending ESC; retain a record through reset.

### PS-20 - echo loop

**Expectation.** A query under echo on and ECHOCTL off sends no reply to the PTY input side; default line discipline sends exactly one, and a later report still applies. **Backing.** `159-program-echo.mjs`. **Mutations.** Remove the line-discipline check and observe an unwanted reply; suppress the default reply; disable parser recovery after suppression.

### PS-21 - cut socket and held redial

**Expectation.** A cut is acknowledged, redial is held before upstream connection, a changed server state is confirmed, and release attaches the new set without another report or focus change. **Backing.** `160-program-redial.mjs` reads the exact redial session frame and background mark; `browser-smoke/lib/terminal-cut-proxy.test.mjs` pins the hold tool. **Mutations.** Send stale attach state; let the held redial upstream early; require another report or focus to repair the page.

### PS-22 - reporter without a terminal

**Expectation.** A process with redirected descriptors and no controlling terminal reports through the subject session's control socket and leaves its record after return; a closed session id is refused. **Backing.** `161-program-headless.mjs` reads the subject terminal's own session id, proves all three detached descriptors and `/dev/tty` are nonterminal, then compares the retained snapshot after a dead-session refusal. **Mutations.** Remove the no-terminal route; tie the record to the short command; accept a dead session id; write to a redirected descriptor.

## Outside the browser

Scenarios 23 and 24 run in `crates/chan/tests/revtunnel_e2e.rs` and `scripts/e2e/devserver-terminal-replay.sh`. This pack does not claim end-to-end `chan upgrade`, Windows, macOS, desktop webviews or a real agent CLI. Other boundaries stay with the roadmap item's Acceptance checks.
