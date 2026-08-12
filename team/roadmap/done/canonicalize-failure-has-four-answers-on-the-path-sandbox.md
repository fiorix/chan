# "Canonicalize failed" is answered four different ways on the path sandbox, and no test holds any of them

Closed: shipped in [v0.89.0](../../release/release-v0.89.0.md).


Status: REGISTERED 2026-08-11 as v0.89.0 scope, carried forward from [audit-the-workarounds-nobody-followed-up](../done/audit-the-workarounds-nobody-followed-up.md), which shipped in v0.88.0 and recorded this as finding F2 without repairing it. The owner accepted it merged with a second draft from the same audit, on the lexical containment helper that exists twice; that draft is folded in below as a subordinate section rather than carried as its own item, because its whole surface sits inside this one's and because the ruling this item asks for may delete the code it wants consolidated.

## What

`crates/chan-workspace/src/fs_ops.rs` asks "what do we do when `canonicalize()` fails?" at four functions on the sandbox boundary and answers it three different ways, and `metadata_archive.rs` adds a fourth. The `fails` column names what will not canonicalize. Every line below was read at `f9c2878c`:

```
function                   file:line                fails   answer
-------------------------  -----------------------  ------  -------------------
ensure_parent_inside_root  fs_ops.rs:299            root    Err, fail closed
ensure_parent_inside_root  fs_ops.rs:305            parent  Ok(()), accepted
target_inside_root         fs_ops.rs:323            root    lexical fallback
target_inside_root         fs_ops.rs:328            path    walk to an ancestor
resolve_safe_strict        fs_ops.rs:1227           root    Err, fail closed
resolve_safe_strict_canon  fs_ops.rs:1248           path    walk to an ancestor
find_git_dir               metadata_archive.rs:669  root    proceed uncanonical
```

The two walk-up rows agree in outcome and differ only in type: `target_inside_root` returns `false` when it runs out of parents (fs_ops.rs:332), `resolve_safe_strict_canon` returns `ChanError::SymlinkEscape` (fs_ops.rs:1254). Both refuse. The `resolve_safe_strict` row is in the table as evidence rather than as work: it is the same question in the same file, and it already answers it the way this item proposes as the default.

The sharpest of the six branches is `target_inside_root`'s root arm. When the root will not canonicalize it defers to `lexical_path_inside_root` (fs_ops.rs:338), which strips the root prefix and requires every remaining component to be `Normal` or `CurDir`. That rejects `..` and nothing else: **it cannot resolve symlinks, which is the entire question `target_inside_root` exists to answer**. A target `sub/link2` where `link2` points at `/etc` is all-`Normal` and reads as inside. The function's only caller is `symlink_target_escapes_workspace` (fs_ops.rs:313).

`ensure_parent_inside_root` is the quieter one. It refuses when the root will not canonicalize, then accepts when the parent will not:

```rust
if let Ok(parent_canon) = parent.canonicalize() {
    if !parent_canon.starts_with(&root_canon) {
        return Err(ChanError::SymlinkEscape(abs.to_path_buf()));
    }
}
Ok(())
```

An unreadable parent is treated as a safe parent, in the same function that treats an unreadable root as fatal.

## The ruling this item asks for already exists, one layer up

The decision of what a canonicalize failure means at the sandbox boundary has already been made and implemented in `chan-workspace` one layer above `fs_ops`, and the finding is four sites that do not conform to it.

`Workspace::open` canonicalizes the registered root in a three-arm match (workspace.rs:845-855): `Ok` binds the canonical root, a `NotFound` error becomes `ChanError::WorkspaceRootMissing`, and any other error becomes `ChanError::Io`. Both failure arms return `Err`, so the handle does not open.

`Workspace::ensure_root_available` (workspace.rs:1355-1400) repeats that check against the live path before every mutating call, with the same three arms, and adds two identity comparisons: the freshly canonicalized root must equal the `root_canon` captured at open (workspace.rs:1385), and on Unix the root's `(dev, ino)` must equal the identity captured at open (workspace.rs:1393). It is called at five sites, in three functions: `ensure_writable` (workspace.rs:1509), `write_atomic_stream` (:1609 and :1626) and `create_draft_dir` (:2363 and :2391).

The consequence worth stating plainly: **`root_canon` is never a fallback value.** It is either the result of a successful `canonicalize` or the call that needed it already failed. Nothing in the write path proceeds on a guessed root.

So fail-closed is the project's implemented position on this question, and what this item wants is the four `fs_ops` sites conforming to it. That is a decision to adopt a precedent, not a decision to invent one.

## Severity: this is a consistency defect and no escape is claimed

Both fail-open answers are reached only through `symlink_target_escapes_workspace`, whose entire output is one `bool` field, `PathClass.target_escapes_workspace` (declared fs_ops.rs:184, computed fs_ops.rs:239-241). That field is reporting data on the wire. `classify_path` is called for it by `path_class_for_wire` (routes/files.rs:302), by the inspector payload (routes/inspector.rs:107), by `path_class_for_graph` (routes/graph.rs:884) and by the fs-graph walker (routes/fs_graph.rs:1128 and :1299), and the SPA renders it as a single chip reading "outside workspace" (`web/packages/workspace-app/src/components/FileInfoBody.svelte:248`). **No write is gated on it anywhere.**

Write enforcement runs elsewhere: `Workspace::ensure_writable` (workspace.rs:1505) calls `ensure_root_available` first (workspace.rs:1509) and then works through the cap-std capability `Dir`. The one site among the four that does gate a real write is `resolve_safe_strict_canon`, reached from trash restore (trash.rs:188), which performs an `fs::rename` outside the cap-std sandbox (trash.rs:200) and therefore carries its own check. That site is the fail-closed one.

`ensure_parent_inside_root`'s fail-open arm is harder still to reach. Its only caller is `classify_path` (fs_ops.rs:218), which three lines later calls `classify_abs` (fs_ops.rs:221), whose first statement is `std::fs::symlink_metadata(abs)` (fs_ops.rs:226). Every condition that defeats `parent.canonicalize()`, a missing component, a denied search permission, a symlink loop, also defeats that `lstat`, so `classify_path` returns `Err` before the accepted parent can be observed. That is an argument from the syscalls involved and not a demonstration; nobody has constructed the case.

**No escape is claimed and none is demonstrated.** What is claimed is that the crate the project's first principle names as the boundary ([`.agents/principles.md`](../../../.agents/principles.md), "Workspace is the boundary") answers its own failure case six different ways across four functions, that the two most permissive answers contradict the ruling implemented one layer above them, and that no test holds any of the six. The concrete live consequence is bounded and real: while the workspace root will not canonicalize, the escape badge in the inspector is computed by a check that cannot see symlinks, so it reads "inside" for a genuine escape. Nothing is written, moved or lost on that basis.

Reaching the degraded paths at all needs a root or parent that will not canonicalize: deleted or renamed under a live workspace, a permission change, or a broken link in an ancestor. Those are reachable but not routine, and none was demonstrated end to end. The audit that found this was reading for `loop` constructs and arrived at the fallback by accident, which is itself part of the case for looking properly.

## What test fails if these sentences are false

The difference between an untested case and an unreachable one is the difference between two different items, so the existing coverage is worth stating precisely.

Four tests in `chan-workspace` do remove the live workspace root: `draft_creation_refuses_missing_workspace_root_without_recreating_it` (workspace.rs:7981), `text_write_refuses_missing_workspace_root_without_recreating_it` (:8004), `open_handle_refuses_a_replacement_at_the_same_root_path` (:8027) and `atomic_text_write_reports_root_removed_during_stream` (:8051). Each of them asserts `ChanError::WorkspaceRootMissing`, and the third also proves the `(dev, ino)` identity check fires by putting a fresh directory back at the same path.

The actual finding is narrower. None of those four reaches any site in the table, because each enters through a writing API that calls `ensure_root_available` first and stops there. They pin the ruling at the `Workspace` layer, which is why that ruling can be treated as settled, and **they cannot distinguish a conforming `fs_ops` site from a non-conforming one**. Flip `ensure_parent_inside_root`'s parent arm from `Ok(())` to `Err`, or the other way, and all four still pass.

Below that layer there is nothing at all. No test anywhere calls `ensure_parent_inside_root`, `target_inside_root` or `lexical_path_inside_root`; a grep over the tree returns only the three production call sites (fs_ops.rs:218, :319, :324). The crate's symlink tests, `classify_path_reports_symlink_escape` (fs_ops.rs:2049), `resolve_safe_strict_rejects_midpath_symlink_to_outside` (:2478) and `resolve_safe_strict_allows_symlink_pointing_inside` (:2490), all run against a `TempDir` root that canonicalizes normally, so every one of them takes the happy branch.

Constructing the missing cases is cheap. The crate already writes permission-shaped tests (`set_permissions(..., from_mode(0o555))` at fs_ops.rs:2040) and `chan-server` already ships `from_mode(0o000)` tests with no euid guard (routes/transfer.rs:1230 and :1678), so a chmod-`0o000` ancestor is an established pattern in this tree rather than one to invent. One caveat for whoever writes them: a suite running as root does not see `EACCES`, so a permission-based case needs either a skip or a non-permission trigger.

## The lexical fallback exists twice, and consolidating it is subordinate to the ruling above

`lexical_path_inside_root` exists twice, with the same body and the opposite parameter order:

```
crates/chan-workspace/src/fs_ops.rs:338
    fn lexical_path_inside_root(root: &Path, path: &Path) -> bool
crates/chan-server/src/routes/fs_graph.rs:1345
    fn lexical_path_inside_root(path: &Path, root: &Path) -> bool
```

The bodies differ only in the closure's binding name. Both strip the prefix and require every remaining component to be `Normal` or `CurDir`, and both are the fallback taken when canonicalization is unavailable: fs_ops.rs:323 when the root will not canonicalize, fs_graph.rs:1329 as the `_` arm of a `(root_canon, canon_target)` match. A grep returns exactly six references tree-wide, the two declarations and four call sites.

Every call site is currently correct, and this was checked, because a reader will otherwise assume it was not:

```
call site                       argument order passed       ok
------------------------------  --------------------------  ---
fs_ops.rs:324                   (root, path)                yes
routes/fs_graph.rs:1329         (target_abs, &self.root)    yes
routes/fs_graph.rs:1459 (test)  (root.join(rel), &root)     yes
routes/fs_graph.rs:1463 (test)  (root.join(rel), &root)     yes
```

So this is a maintainability hazard and not a live containment bug. Both functions take two `&Path` arguments, so a transposition compiles. Passing `(path, root)` into the `(root, path)` copy computes `root.strip_prefix(path)`, which for an ordinary outside target such as `/etc/hosts` returns `Err` and refuses, which is fail closed. The genuine fail-open case is narrower and real: a target that is a strict ancestor of the root strips cleanly into all-`Normal` components, so a symlink pointing at the workspace root's parent would be reported as contained.

The two copies are not equally protected. `fs_graph.rs` has `lexical_fallback_rejects_parent_escape` (routes/fs_graph.rs:1456), which asserts both directions. The `fs_ops` copy has no test at all, and it is the one on the crate the first principle names as the boundary.

Consolidating does not move a security-boundary helper across a new crate line or hand `chan-server` a dependency direction it does not already have: `chan-server` already depends on `chan-workspace` (crates/chan-server/Cargo.toml:39), `fs_ops` is already a public module (crates/chan-workspace/src/lib.rs:32), and `fs_graph.rs` already calls into it, documented at its module header (routes/fs_graph.rs:11) and used at `resolve_safe` (routes/fs_graph.rs:357). Mechanically the consolidation is: make one function `pub`, delete the other, update one call site and two test assertions.

**Why this is folded in rather than scheduled beside this item.** The `fs_ops` copy exists only to serve the canonicalize-failure fallback at fs_ops.rs:323. If the ruling above removes that fallback in favour of refusal, the `fs_ops` copy goes with it, one copy remains, and there is nothing left to consolidate. Carrying it as a separate item guarantees either two lanes editing the same twenty lines or consolidation work the ruling then discards. It is listed here so that whoever takes the ruling has the duplication in front of them, and so the outcome is recorded either way.

## Contract

- One answer to "canonicalize failed" at the sandbox boundary, and it is the fail-closed answer already implemented in `Workspace::open` and `Workspace::ensure_root_available`. A site that must differ says why, in the file, at the site.
- A degraded check never silently substitutes a weaker guarantee for the one its caller requested. If the lexical check cannot answer the symlink question, a caller asking the symlink question does not get the lexical answer.
- Either one implementation of the lexical containment check survives, or none does. Two copies of one containment rule, in opposite argument orders, is not an outcome this item accepts.

## Boundary

In scope: the four functions in the table, plus `lexical_path_inside_root` in both crates, which means `crates/chan-workspace/src/fs_ops.rs` **and `crates/chan-server/src/routes/fs_graph.rs`**. `resolve_safe_strict` (fs_ops.rs:1227) is evidence, not work; it already answers the way the ruling says.

The second file is named explicitly because leaving it implicit is exactly how this item's server half stayed open after the headline repair landed. The lane surface was derived from the item's headline files, the headline repair is entirely in `chan-workspace`, and a reader deriving scope that way finds nothing pointing at `chan-server`. That happened, was caught by reading this acceptance section against the tree rather than by reading the lane's report, and is the third instance of the same shape in this round.

Deliberately out, and named here so the next reader does not reopen it: every canonicalize-failure site beyond the sandbox containment checks. A crude count over `crates/chan-workspace/src` and `crates/chan-server/src`, classifying each `canonicalize(` call by how the following lines handle failure, gives roughly 31 non-test decision sites (6 `.ok()`, 3 `let Ok`, 4 `map_err`, 9 `match`, 9 `unwrap_or_else`) against 23 `.unwrap()`s in tests. That is roughly five times the surface this item takes, and most of it is off the sandbox path. Two examples of what is out and why: `paths::canonicalize_normalized` (paths.rs:136) falls back to the stripped input, but its job is making the CLI and the devserver agree on a path's spelling for lock records, not answering a containment question; `Workspace::physical_path_to_virtual` (workspace.rs:1324) falls back with `unwrap_or_else(|_| path.to_path_buf())` and then returns `None` when the result is not under the canonical root, so its failure mode is a missing mapping rather than an admitted path.

Auditing the remaining canonicalize-failure sites is a separate item if anyone wants one. This item is the sandbox containment checks and nothing else.

## Acceptance

- Tests construct both the uncanonicalizable-root and the uncanonicalizable-parent case and assert the chosen behaviour at each site in the table. Six branches that currently have zero coverage end with coverage.
- `ensure_parent_inside_root`'s two arms agree, or the file says at the site why they must not.
- The lexical fallback either states in code what weaker guarantee it provides and which callers may accept it, or it is removed in favour of refusal.
- If the fallback survives, exactly one implementation of it survives, it is covered in both directions by a test on `chan-workspace` rather than only on the crate that consumes it, and its signature does not admit a silent transposition of two same-typed path arguments. If it is removed, the `fs_ops` half of this clause is satisfied by its absence.
- A reader can tell, from `fs_ops.rs` alone, which answer each site gives and why, without reading `workspace.rs` to discover that a ruling exists.

## Result, recorded 2026-08-11

Landed in two commits, and the split is the finding as much as the repair.

`2e1c1f01` is the headline repair, one file, `crates/chan-workspace/src/fs_ops.rs`. `ensure_parent_inside_root` refuses an uncanonicalizable parent, `target_inside_root` refuses an uncanonicalizable root and every path error except `NotFound`, and `resolve_safe_strict_canon` walks only missing leaves. Missing create targets still resolve against their deepest canonical existing ancestor. The symlink-blind `fs_ops` copy of the lexical fallback was removed rather than annotated, which satisfies the clause above by absence.

`25cd4236` closes the server half, one file, `crates/chan-server/src/routes/fs_graph.rs`. **That half stayed open after the headline repair read as complete**, and it is why the Boundary above now names the file. The surviving helper is now the method `FsGraphWalker::lexical_path_inside_root(&self, path)`: the root comes from the walker whose root defines the answer, so there is no longer a pair of same-typed positional path arguments to transpose. That is the acceptance clause about the signature met **structurally** rather than by convention, and it is proportionate for a private helper with one caller, where a newtype would have cost more than it bought. Its doc comment now states the weaker contract at the site: symlink-blind, cannot prove filesystem containment, acceptable only to `target_is_inside_workspace` when canonicalization is unavailable so that missing in-workspace graph ghosts stay visible, and no write is gated on the result.

Both halves carry adversarial proof taken on the committed sha rather than inherited, and each names the assertion that failed rather than reporting a red exit code:

- Restoring lexical root acceptance failed `canonicalize_failures_refuse_an_unavailable_workspace_root` at `assert!(!target_inside_root(&root, &target));`.
- Restoring fail-open parent handling failed `canonicalize_failures_refuse_an_unavailable_path_parent` because `ensure_parent_inside_root` returned `Ok(())` instead of `Err(ChanError::Io(_))`.
- Reversing the `strip_prefix` direction in the surviving helper failed `lexical_fallback_rejects_parent_escape` at its positive inside-path assertion.

Each reverted to green afterwards, so no green in this record precedes the edit it certifies.

One process note worth keeping with the item. The gap between the two commits was not found by reading the lane's report, which was accurate and complete about what it had done. It was found by reading this Acceptance section against the tree. An item whose acceptance has two halves in one sentence can be honestly reported as done when only one half is closed.

```citations
crates/chan-server/src/routes/fs_graph.rs	FsGraphWalker::lexical_path_inside_root	1	fn lexical_path_inside_root(&self, path: &Path) -> bool {
crates/chan-workspace/src/fs_ops.rs	canonicalize_failures_refuse_an_unavailable_workspace_root	1	assert!(!target_inside_root(&root, &target));
```

## Rough size

Small to medium. The code at each site is a handful of lines, and the ruling is largely pre-decided, because `Workspace::ensure_root_available` is the precedent: adopting it costs a decision to conform rather than a decision from scratch. The real cost is the tests, which have to construct an uncanonicalizable root and an uncanonicalizable parent and pin six branches that have no coverage today, on a pattern the crate already uses elsewhere. The folded consolidation is a few lines on top of that, and may cost nothing at all if the ruling deletes the fallback.

It inflates toward large only if the contract is read as covering all ~31 canonicalize-failure sites rather than the sandbox containment checks. The boundary section exists to stop that reading.
