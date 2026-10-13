# Browser check 105 times out on its custom colours write after other checks

Status: raised by the hygiene seat on 2026-10-13 from a red in its whole browser run at two CPUs, then counted (`tasks/task-Hygiene106-Lead106-32.md` and `tasks/task-Hygiene106-Lead106-33.md` in the round's bus); written down the same day by the lead as a row of its own; owner the frontend seat; a diagnosing repair of the check ordered in the v0.106.0 round; the cause is not established.

## What was seen

In the whole browser suite at the integration commit `ea4b04f18`, in a guest capped at two CPUs, check 105 failed on its 15 s wait for a successful `/api/config` PATCH and passed alone. Counted at the same frozen build, interleaved: the file-order prefix of seven checks ending in 105 went red once in ten runs, on the same wait; check 105 alone went red in none of ten. In both reds the first font-size edit had been saved and the page reloaded; the wait that timed out is the one armed before the click on the custom terminal colours checkbox (`scripts/e2e/browser-smoke/checks/105-terminal-appearance.mjs` 323 to 331), no `config_changed` frame followed until the check's own cleanup, and the red screenshot shows the checkbox unchecked. The red run's CPU throttling and I/O pressure were inside the range of the passing prefix runs. The six checks before it make no config write, by their sources.

By source: the wait is armed before the action, so a response cannot be missed for arriving early; its predicate accepts any successful config PATCH and does not tie it to this control or read the returned preference; the settings overlay applies the edit optimistically and queues one serialized write that sends no PATCH at all when the value is already current (`api/preferenceWrite.ts` 28 to 63); the failure record keeps HTTP errors and slow or failed requests and omits fast successful config responses, so neither red timeline can say whether a PATCH was sent.

Not established: whether the click reached the checkbox, whether a PATCH was sent, refused or delayed, or whether the edit was applied and reverted; whether the cause is the check's, an order dependence on the earlier checks' state, or a product fault in the settings write; the rate at four CPUs.

## Desired contract

The check's custom colours leg fails with a sentence that says which step was lost: the control's state before the click, the click's effect on the control, the request, its answer, or the server's stored value. It passes on the server's stored value for this write, not on any successful config response.

## What to do

Repair the check, test only, as a diagnosing change: assert the checkbox unchecked after the known standard-colours write; record the config revision before the action; click; wait for the server's `terminal_colors.mode` to read `custom` under the same 15 s bound, and on a timeout report whether no PATCH was sent, one was refused, or one was answered late, and the control's state. Then count the prefix arm again. A product fault the new sentence shows gets an item of its own.

## Boundaries

`scripts/e2e/browser-smoke/checks/105-terminal-appearance.mjs` and, if the request record is needed, `scripts/e2e/browser-smoke/lib/failure-record.mjs`. Not changed: the settings overlay, the preference write queue, the config route, the 15 s bound.

## Acceptance

1. The custom colours leg waits on the stored value of its own write and names the lost step when it fails; shown able to fail at each named step by a constructed stand-in or a guest-only product mutant.
2. The file-order prefix through check 105 twenty times at the commit in the owning guest, each red kept with its sentence; the classification recorded here from what the sentences say.

## The diagnosing repair reviewed and landed; two findings ruled 2026-10-13

The hygiene seat's one commit replaces the toggle's wait for any response with a leg that says which step was lost. Before the click it requires the stored mode to be standard and the control unchecked. After it, in one evaluation at or before a fifteen-second deadline, it requires the control read checked, a PATCH whose body sets the custom mode answered 2xx, a stored revision newer than the one read before the click, and the stored mode custom, read by a fresh `GET /api/config`. Each way of falling short has a sentence of its own.

The review seat read it (`reviews/review-Review106-chk105-diagnose-1.md` in the round's bus; a reading, nothing run): the leg cannot pass without the write stored; it can fail with the write stored in one narrow case, a write sent, answered and stored while the single sample of the control read unchecked, and its sentence shows that case; a stored custom mode left by an earlier step, on which the old wait passed, now stops at the baseline with the stored mode and revision. Nine constructed red cases over six sentences and one real mutant are the seat's. Landed on `v0106/int` as `ab8ae8d43`; the check parses there.

The cause of the one red in ten is still not established. The repair makes the next red say which step was lost; the seat's twenty green runs of the check after the six before it were of another build and do not bear on a one-in-ten rate. The three other waits of the check are untouched and would still read as a bare response timeout.

Two findings, ruled built by the hygiene seat: "no custom-mode PATCH sent" is also what a PATCH the observer could not read as one gives, so the sentence's tail counts every other config PATCH seen in the window; and two sentences have no constructed case, the request-failed branch and the custom mode arriving after the deadline, which moves into the pure function so that a case can hold it. The count this item orders follows that commit, in the candidate's browser run.
