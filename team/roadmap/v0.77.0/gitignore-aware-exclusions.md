# Honor .gitignore in walk and watch exclusions

Status: REGISTERED for v0.77.0. The fuller shape of the rebuild-storm
lever 1; the defaults + migration half shipped in v0.76.0
(`index_excluded_dirs` now covers Buck2-class output trees, and Linux
watch registration prunes excluded subtrees). chan still never reads
`.gitignore`.

## Problem

Users describe their build/output trees in `.gitignore` already.
chan's walk, index, graph rebuild, and watcher only honor the fixed
basename list (`index_excluded_dirs`), so every project with a custom
output dir must duplicate its ignore rules into chan's config or be
walked/watched/indexed wholesale.

## Boundaries / decisions to make at spec time

- Matcher: the `ignore` crate (gitignore semantics incl. per-dir
  files and negation) vs a homegrown subset. New dependency needs
  justification either way.
- Layering: `.gitignore` as the base set, `index_excluded_dirs` as
  additive user overrides; decide precedence and how negation (`!`)
  interacts with the hard invariants (`.git`, `.chan` always
  internal).
- Linux watch registration (the manual filtered recursion from
  v0.76.0) must consult the same matcher at registration and in the
  new-directory tracker, not just at dispatch.
- Performance on large trees: per-dir `.gitignore` discovery must
  not become a second full walk on its own.

## Acceptance

- A workspace whose only exclusion is a `.gitignore` entry walks,
  indexes, and watches nothing under that entry; events inside it
  never fire (Linux registration test mirrors the v0.76.0 suite).
- `index_excluded_dirs` keeps working unchanged on top.
