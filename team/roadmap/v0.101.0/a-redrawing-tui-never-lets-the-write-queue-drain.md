# A TUI that redraws while idle never lets the write queue drain

Status: accepted for v0.101.0 by the owner on 2026-09-20. Raised that day on the owner's instruction, it was ruled for the first option, built with regression tests and measured against the supported agents, and accepted on those results. The build is one commit, `055f3b90e` on the local branch `fix/write-queue-idle-signal`, kept as the reference: it is not pushed and has not landed, and the round takes it through intake as it would any branch that arrives built. The code claims are a source reading against `main` at `407071718`. The two byte-stream measurements were taken live and read-only with `cs terminal scrollback`, over windows of 12 to 25 seconds, on one machine. The 60 Hz redraw that prompted the item is the owner's report of Muse Code and was not reproduced: the specimen measured here sat in a background tab and redrew about once every ten seconds.

## What was seen

The write queue's only idle signal is output silence. `record_output` (`crates/chan-library/src/terminal_sessions.rs`) stamps `last_output_at` on every non-empty PTY read, whatever the bytes are, and `try_drain_batch` delivers nothing until that stamp is `WRITE_QUEUE_QUIET_MS` (800 ms) old. A program that writes anything more often than that holds its queue for as long as it runs. Nothing queued is lost while it holds: `push_message` refuses a new write once the FIFO has `WRITE_QUEUE_CAP` (100) entries and `EnqueueOutcome` counts it as `full`, so the sender starts seeing refusals and the queued messages wait. The same stamp answers a second question, whether generation started after a delivery (`last_output > delivered_at` while `awaiting_gen`), so redraw noise answers that one yes as well.

Muse Code 1.3.0, started by hand in a shell tab, wrote this while idle and nothing else:

```
ESC[39m ESC[49m ESC[59m ESC[0m ESC[38;3H
```

That is 26 bytes: three colour resets, an attribute reset and a cursor placement, with no printable character. It is consistent with a ratatui `draw()` over an unchanged buffer through the crossterm backend, which is the owner's account of the cause; Muse's source was not read. The rate did not match the report. The session's replay ring had not wrapped since the shell started and held about 105 such frames in all, so that session never sustained 60 Hz, and sampled every 250 ms for 25 s it produced two frames, 8 and 10 seconds apart. At that rate the 800 ms gate is open nearly all the time and the queue drains. Muse had asked for focus reports (`ESC[?1004h`, one of the library's `TRACKED_PRIVATE_MODES`) and the tab was in the background for every sample, which suggested a redraw loop that runs only while the tab has focus. Measured, it does not: in a PTY of its own, sent a focus-out and then a focus-in, Muse wrote two reads in 5.5 s and two in 7.4 s, none with a printable byte. No state reachable on this machine redraws at 60 Hz, and a working turn is not reachable: Muse's turns fail here on a 402 billing error.

The legitimate case looks different on the wire. Claude Code in the middle of a tool call wrote about 920 bytes a second, of which about 150 a second were printable: the spinner glyph, the verb, the timer. An agent blocked inside `cs terminal survey`, or inside any long tool call, looks like that for as long as it blocks, and its queue has to keep holding.

`visible_activity_bytes` (`terminal_sessions/bytes.rs`) already tells the two apart. `record_output` calls it for the tab activity dot, for the reason that applies here: cursor motion, SGR, OSC titles, BEL and CR/LF are what a PTY emits while idle. A Python port of it scored the Muse frames 0 and 12 s of the Claude stream 1827. It carries no state between reads, though. A CSI cut by the 8192-byte read boundary leaves its tail (`8;3H`) at the head of the next read, where the parameters and the final byte count as printable.

One more reading of the specimen: `cs terminal list --json` reports `agent: null` for that tab, because Muse is not a `SubmitAgent` and was started inside a shell. A write without `--submit` is delivered there with no chord and sits unsubmitted in the compose box, which from the sending side can be mistaken for a queue that never flushed. Which `--submit` encoding Muse's compose box accepts was not probed.

## Desired contract

A program that repaints an unchanged screen does not hold its write queue, and a program that is visibly working still does. Nothing queued is dropped or delivered early to get there: a held queue stays held, and the sender can see that it is held and for how long.

How idle is decided is the owner's ruling. Three ways were weighed:

1. **Printable output is the signal.** `last_output_at` moves only when a read carries printable bytes, by the rule the activity dot already uses, with the escape-parser state carried across reads the way `alt_screen_tail` and `dsr_tail` carry theirs. It covers the Muse frame as measured, whatever the redraw rate. It is a rule about bytes and not about agents, so it reaches a session that derives no agent, which the specimen was. It does not cover a program that re-emits unchanged text on every frame, and it reads a program as idle when its only sign of work is an escape sequence, such as a spinner kept in the window title alone. None of the six submit agents (agy, claude, codex, gemini, kimi, opencode) is known to work that way; the drain matrix has to show it.
2. **A changed screen is the signal.** The library keeps a cell grid per session and stamps only when a read changes it, which covers a full repaint of unchanged text too. It adds a terminal-emulation dependency (none of `vt100`, `vte`, `alacritty_terminal` or `termwiz` is in `Cargo.lock`), parsing cost on every read of every session, and a grid the library has so far gone without: the DSR fallback answers `1;1` because it "has no terminal grid to measure". It also reads idle more eagerly than the first. A program that repaints at 60 Hz and changes one counter a second is busy under the first rule and has one-second gaps under this one, longer than the 800 ms gate. Reading a busy agent as idle types into its compose box, which is the costlier of the two errors; the team bootstrap already warns that a silent busy turn has this problem.
3. **A held queue is flushed after a deadline.** Weighed and not recommended as a delivery rule. An agent waiting on a survey animates for minutes, so any deadline short enough to help the redrawing program delivers into a working agent, and dropping in place of delivering loses messages the sender was told were queued.

Owner ruling, 2026-09-20: the first option, built with regression tests and measured against the agents we support before anything else is decided.

Owner ruling, 2026-09-20, on the measurements below: the first option is accepted for v0.101.0 and its build stays on a branch as the reference. The reporting part was not ruled on.

The reading favours the first alone, with the second kept back until a measurement shows a program the first does not cover. What survives of the third is reporting: how long the head of a queue has waited, beside `queue_depth`, so a lead sees a held queue before it sees refusals at 100. The owner can take or strike that part separately.

## Boundaries

`record_output`, `try_drain_batch`, the `last_output_at` field doc and the queue's header comment in `crates/chan-library/src/terminal_sessions.rs`; `visible_activity_bytes` in `terminal_sessions/bytes.rs` if it gains carried state, which the activity dot then shares. The sentences that describe the signal: `generate_bootstrap_md` in `crates/chan-server/src/routes/team_config.rs` ("The queue's idle signal is PTY output silence") with the test that pins it, `.agents/orchestration/README.md` ("deliver when the target's PTY goes output-quiet"), and the `cs terminal write` help in `crates/chan-shell/src/help.rs`. `scripts/e2e/terminal-queue-drain.sh` for the matrix. If the held time is reported: the session inventory behind `cs terminal list --json`, beside `queue_depth`.

Out of scope: a TUI that is silent while it shows a modal, a permission or question dialog, receives the queued write today and would under every option here. What each agent does with it was not observed, and it is its own item if it matters. Making Muse a `SubmitAgent` is separate too and needs a live probe of its chord.

## What the build measured

The reference commit replaces `visible_activity_bytes` with `VisibleScan`, a four-state scanner whose position is carried across reads, and `record_output` moves `last_output_at` only on a read with visible bytes; the activity dot shares the count. An OSC payload is skipped for at most 4096 bytes, so an unterminated one errs toward counting text and never toward a silent verdict. Nine unit tests cover it. With the old rule put back, the three that feed the measured frame fail and the one that expects a printing program to hold the queue passes, as it should under both rules.

Two instruments ran on the build host, both outside the live devserver. A PTY recorder stamps every 8192-byte read and judges the stream by both rules. A library probe drives the patched `Registry`, PTY reader and drainer against a real program: one write into the idle program, a second enqueued three seconds into a turn that runs `sleep 20`.

| agent | idle output | busy turn, max gap any / visible | mid-turn write |
| --- | --- | --- | --- |
| claude | none | 24.0 s, 231 / 231 ms | held 21.3 s, out 867 ms after |
| kimi | none | 43.3 s, 204 / 237 ms | held 27.7 s, out 952 ms after |
| agy | escapes, every 2 s | turn fails | not run |
| muse | escapes, every 10 s | turn fails (402) | not run |
| stand-in | frame at 60 Hz | 20 s spinner | held 17.9 s, out 842 ms after |

No gap in either busy turn reached the 800 ms threshold under either rule, so the ruling changes no verdict for claude or kimi, and both answered the held write in a turn of its own. The stand-in is a script that writes the measured frame at 60 Hz and draws a spinner on request, read through a real PTY over 4127 reads: its first write landed 116 ms after it was enqueued, where the old rule never delivers it. agy turned out to be a second program with escape-only idle output: `ESC[?2004h ESC[>4;2m ESC[=1;1u` every two seconds, slow enough to drain today, fast enough to pass for generation start after any delivery under the old rule.

Not measured: codex, gemini and opencode are not installed on the build host, and neither agy nor muse can run a turn there. `terminal-queue-drain.sh` was not run, because it needs a server under test; the library probe stands in for its held-while-busy claim for two agents and for none of its batching cases. The probe, the recorder and their summaries are kept in the ignored `dev/wq/probes/` of the branch's worktree. Of the acceptance below, the branch meets 2, 3, 4 and 6, answers 1 with a different result than expected, leaves 5 open, and does not build 7.

## Acceptance

1. Before the ruling, the specimen is measured with its tab focused: bytes a second and printable bytes a second over ten seconds, by the `visible_activity_bytes` rule. About 1.5 kB a second with no printable byte confirms the report and says the first option covers it. A printable rate above zero says it does not, and the capture names what repaints.
2. A test feeds `record_output` the measured 26-byte frame faster than the quiet threshold with a write queued and sees it drain; the same frame with one printable byte added holds it.
3. A test splits that frame across two reads at every offset and no read counts as printable.
4. A frame with no printable byte does not release `awaiting_gen`: tested.
5. The drain matrix passes 3/3 for claude, codex and gemini as it does today, and the run records that each agent's busy state carries printable bytes.
6. The three sentences that describe the signal say what the code does.
7. If the reporting part is accepted: a queue whose head has waited is visible in `cs terminal list --json` with how long, tested.
