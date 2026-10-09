# Two more empty-pane animations and tuned defaults wait on the night-sky branch

Status: shipped in [v0.104.0](../../release/release-v0.104.0.md).

Record before the release: accepted for v0.104.0 by the owner's word of 2026-10-09 in the lead's terminal, after the first candidate was built ("i will want to merge in the work in the `anim/night-sky` branch. Latest commit: `6fad3c4a1`"), with the owner's later word that the version needs no second candidate for it ("once we merge we dont even need rc1, we can go ga"); picked, adapted, reviewed and landed on the integration branch on 2026-10-09 (see Landing); the owner's branch is never rewritten or moved.

## What was seen

The owner's branch `anim/night-sky` holds three commits over `chan-anim` (`32c93aba5317d06e4cec0fa20059282e8220f43e`), read on 2026-10-09 at `6fad3c4a1b1ae2d6b87528003f38abb2ec1ec33f`: the Cosmic Bell animation (`9c3768d71`), the Segmented Torus animation (`7a54bb6f9`) and a tuning of the default field scale, tone and opacity of ten animations (`6fad3c4a1`). The diff against `chan-anim` is 18 files, 1,164 insertions and 48 deletions, all under `web/packages/workspace-app/`, with no lockfile. Of the ten tuned animations, Amber Recursion is the only one that shipped before this version; the other nine arrive in it.

The branch predates the integration branch's catalog, where every animation names its `runner` (`2d` or `webgl2`) so that the welcome keeps to the 2D canvas on a software WebGL context. The three commits apply without a textual conflict and leave both new entries with no runner. Each commit's message says its browser checks rendered on software WebGL and that hardware GPU performance was not measured.

## Desired contract

The two animations and the tuned defaults are on `main` as the owner wrote them; both new entries are classified by the runner they request, so neither is chosen at random or restored from storage on a software or absent WebGL2 context; a caller may still explicitly name either animation; `make web-check` is green; the changelog counts and names them.

## Boundaries

`web/packages/workspace-app/` and `CHANGELOG.md`. No change to the picked commits' content; what the integration needs is separate commits on top, reviewed on their own. The start delay and the software-context rule of the welcome are not changed.

## Acceptance

1. The three commits are on the candidate as picks, each new sha mapped to its original, with author, subject, body and patch unchanged; no commit of the owner's branch was rewritten or moved.
2. Both new catalog entries carry the runner their components request, pinned by a test that compares every catalog row with what its component asks for.
3. `make web-check` is green in a guest at the pinned Node on the integrated tip, with the run's log and exit status; a red on the way is kept.
4. The changelog's animations entry counts ten and names both, and a changed default of an animation that shipped before has its own line.
5. The whole gate and the browser suite run on the tree that carries them before the release.

## Landing 2026-10-09

The frontend seat picked the three commits in order onto a branch from the first candidate's pin commit (`dev/v0104-team/tasks/task-Frontend104-Lead104-35.md`): `31e321755` from `9c3768d71`, `8fff9108a` from `7a54bb6f9`, `b3b9e456f` from `6fad3c4a1`, and added two commits of its own: `d3b18d612`, which gives both new entries `runner: "webgl2"` (each component calls the shared WebGL2 runner) with a catalog pin, and `97095ec98`, which names the new last catalog entry in the welcome's choice test. The first `make web-check`, at `d3b18d612`, was red (exit 2): 6,795 workspace-app tests passed and two arms of that choice test failed, because they pinned the former last entry `eightfold-coil` and drew `segmented-torus`; the red is kept (`dev/v0104-team/evidence/Frontend104/night-sky/web-check-tip.log`). The second, at `97095ec98` in the seat's guest at the pinned Node, exited 0: 7,612 tests passed across the four packages (217, 578, 6,797 and 20), four `svelte-check` runs at zero, the production build complete (`web-check-fixed.log`).

The reviewer read the range (`dev/v0104-team/tasks/task-Review104-Lead104-170.md`) and accepted it with no finding: for each of the three picks the author, subject, body, paths and every added and deleted line match the owner's commit; the choice filter keeps both new ids out of the random draw, the keys and a saved choice on a software or absent context, and a caller's explicit choice remains the existing named override; the defaults pick touches ten components' numeric token defaults and their matching fallbacks only. The range landed on the integration branch by fast-forward, so the landed commits are the reviewed ones (`97095ec98c53fe881731be4e90658d061cfdecbc`, 19 files, 1,182 insertions and 49 deletions over the pin commit).

Not established at the landing: a browser run of the combined tip, the two animations' appearance or frame rate on a GPU, and a fresh reading that the tuner page stays out of the embedded bundle, whose token map gained two entries with no build configuration changed. No publish=false release dry run exists for a tree that carries this range; the release report records what ran on it.
