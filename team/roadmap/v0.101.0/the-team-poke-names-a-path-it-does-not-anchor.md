# The team identity poke names a relative path and never says what it is relative to

Status: raised for v0.101.0 from [issue #7](https://github.com/fiorix/chan/issues/7), reported against 0.98.0; the owner agreed the target and ruled on the shape on 2026-09-20. The code claims below are a source reading against `main` at `8597521d1`. The reported agent behaviour (a weaker model walking the tree instead of reading the file) is the reporter's observation and was not reproduced here.

## What was seen

`identity_prompt` (`crates/chan-server/src/routes/team_config.rs`) ends every poke with `Read the team process at {team_dir}/bootstrap.md`, where `team_dir` is the workspace-relative directory on the wire. From the workspace root that is the string the caller typed, as the issue says; from a subdirectory `resolve_team_dir` (`crates/chan-shell/src/cli.rs`) has already resolved it against the caller's directory. The path is valid, because `spawn_team` (`crates/chan-server/src/control_socket.rs`) creates each member with `cwd: None` and the registry falls back to the workspace root (`crates/chan-library/src/terminal_sessions.rs`), but the poke never says so. An agent that does not assume its working directory is the anchor has nothing to resolve `berries/bootstrap.md` against, and a team directory is commonly gitignored, so the `fd` or `rg` it reaches for next returns nothing.

`--brief` cannot repair it: the brief lands inside `bootstrap.md`, which is the file the agent has not found yet.

There are two more sites the issue does not name. The SPA builds its own poke with the same shape: `identityPrompt` in `web/packages/workspace-app/src/state/teamOrchestrator.svelte.ts` receives `{teamDir}/bootstrap.md`. And the script that `--script` emits (`generate_bootstrap_script`) writes `{dir}/` relative to the shell's working directory while the tabs it opens start at the workspace root, which is why its header has to ask to be run "at the workspace root so the relative paths resolve". Run anywhere else, the tree lands in one place and every member is pointed at another.

## Desired contract

Every way of bringing a team up (the dialog, `cs terminal team new`, `team load`, and the script either emits) tells each member the absolute path of `bootstrap.md` and names the directory that document's relative paths resolve against, and that path is where the tree is. The aim is a poke that is familiar and hard to get wrong, without new surface.

Owner ruling, 2026-09-20: absolute, unconditionally. No flag and no config key: the poke is computed at spawn time on the host the agent runs on, so the absolute form is always correct there and the relative form saves only characters.

Owner ruling, 2026-09-20: `bootstrap.md` keeps its workspace-relative paths. It is a persisted workspace file that can be committed and shared, `load` spawns a saved team without regenerating it, and a moved or cloned workspace would carry stale paths and the author's home layout. The issue's ask to absolutize its *How we work* and *Files* sections is declined for that reason; the directory named in the poke anchors them.

Owner ruling, 2026-09-20: the script anchors on `$PWD`. It resolves the team directory once, at the top, from `$PWD`, and uses that one value for the tree it writes and for the poke it sends, so the two cannot disagree wherever it is run and the run-from-the-root precondition goes away.

To settle in the build: the directory the script carries. Today it is the workspace-relative form the CLI resolved at generation time, which joined to `$PWD` lands where the direct form does only from the workspace root; from a subdirectory `sub`, a team typed as `berries` lands in `sub/sub/berries`, where its members find it and `team load berries` does not. Carrying it unchanged and having the script print the resolved directory before it writes is the smaller change. Carrying the typed name would make the script land where the direct form does from any directory, at the cost of a second `dir` on the wire, because `load --script` still reads the config through the workspace.

## Boundaries

`identity_prompt`, `generate_bootstrap_script` and its header comment in `crates/chan-server/src/routes/team_config.rs`; `handle_team` and `spawn_team` in `crates/chan-server/src/control_socket.rs`. Both direct arms of `handle_team` already hold the `Workspace`, so the root is in hand; on Windows it goes through `strip_verbatim_prefix` (`crates/chan-workspace/src/paths.rs`) before it is shown. The scripted poke is emitted inside `$'...'`, where `ansi_c_escape` leaves `$` literal on purpose, so the `$PWD` value is spliced in outside that quoting.

`identityPrompt` in `teamOrchestrator.svelte.ts`; the SPA already holds the full root as `WorkspaceInfo.root` (`web/packages/workspace-app/src/api/types.ts`). `resolve_team_dir` in `crates/chan-shell/src/cli.rs` only if the typed name is what the script carries. `.agents/orchestration/teams.md` where it describes the script form.

## Acceptance

1. A test asserts the lead and worker pokes from the direct spawn path contain the absolute `bootstrap.md` path under a temporary workspace root and name that root; `load` shares the path and is covered by the same assertion.
2. A test asserts `generate_bootstrap_md` output contains no absolute path, so the persisted document stays portable.
3. A test runs the emitted script from a directory that is not the workspace root, with `cs` replaced by a recorder, and finds the tree under that directory and the recorded poke naming the same absolute path. The script's header no longer asks for the workspace root.
4. The SPA poke carries the same absolute path, pinned by a test on the prompt text.
5. The directory the script carries is settled one way, and `teams.md` says where a scripted team lands.
6. The issue is answered with what shipped and what was declined, and why.
