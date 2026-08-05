---
name: archive-round
description: >-
  Move a finished round's raw data out of the chan checkout's dev/ tree
  into the chan-dev archive, sanitizing machine paths and identity before
  it becomes public history.
when_to_use: >-
  At round close, when asked to move a team's raw data, journals, tasks,
  or reports to chan-dev, or before committing anything there.
---

# Archiving a round into chan-dev

Rounds run in `dev/` inside the chan checkout, which is gitignored and local. `../chan-dev` is a separate repository that keeps that material as durable history and is intended to become public. Moving files between them is not a copy: everything crossing the boundary is written for one machine and has to be rewritten for readers who do not have it.

Copy, sanitize, verify, then commit. Never commit the copy first and clean it up afterwards, because the unsanitized version stays in the history.

## What the round tree carries that the archive must not

Agents are routed by absolute path, so briefs, `config.toml`, task files, and journals name the worktree they ran in. Archived verbatim, every one of those becomes a literal home path in public history. This is the single largest source of drift and it recurs every round.

| in the round tree | in the archive |
| --- | --- |
| `/home/<user>/dev/github.com/<user>/chan-v0840` | `<checkout-root>/chan-v0840` |
| any other path under the home directory | `$HOME/...` |
| the chan checkout itself, referenced from an archived doc | `<chan-source>/...` |
| maintainer display name or personal email | `@@Alex` |
| Apple signing identity, team identifier | `<signing-identity>`, `<apple-team-id>` |

`@@Alex` is the handle the archive uses for the maintainer throughout. Do not invent a substitute like "the repository owner"; it reads as a different person and breaks prose that already uses the handle.

## Sequence

1. **Copy into place.** Round records go to `releases/<version>/`; investigations with no release home go to `lost-and-found/`. Merge into an existing round directory add-only, and never overwrite a file the archive already has. Independently numbered screenshots collide (`image-1.png` means different things in the two trees), so continue the archive's sequence instead of clobbering.

2. **Sanitize before staging.** Apply the table above to every copied text file.

   ```bash
   perl -0777 -i -pe '
     s{(?:/home|/Users)/[a-z]+/dev/github\.com/[a-z]+/}{<checkout-root>/}g;
     s{(?:/home|/Users)/[a-z]+}{\$HOME}g;
   ' <files>
   ```

3. **Leave artifacts behind.** Installers, packages, archives, `.pyc`, PDFs, video, audio, and anything holding a credential stay in `dev/`. `chan-dev/.gitignore` already matches them. Screenshots do come across: the smoke reports and bug requests that cite them are unreadable without them. Record anything omitted in a manifest under `lost-and-found/` with its size and SHA-256 so the omission is auditable and reversible.

4. **Fix the links the move breaks.** Relative links that resolved in `dev/` often do not resolve at the new depth. Point references to the chan source tree at `<chan-source>/...` in backticks rather than as links. Leave prose that discusses link syntax alone: `[x](x.md)` inside a sentence about Markdown is not a broken link, and the archive is full of it.

5. **Check the commit identity.** `git config --local user.email` in `chan-dev` must be the ID-based noreply address. Repository-local configuration is not inherited by a clone, so it is absent in every fresh checkout and the commit silently falls through to the personal global identity.

6. **Scan the staged set, then commit.**

   ```bash
   git ls-files -z | xargs -0 rg --text --no-ignore -l \
     '(/home/[a-z]+|/Users/[a-z]+|<display name>|<personal email>)'
   ```

   Expect no hit. Review `git diff --staged --name-only` for anything matching `.env`, `.exe`, `.pdf`, `.pyc`, or `DS_Store` before the commit lands.

## Invariants

- **Sanitize before the commit, not after.** A follow-up cleanup leaves the original in the history, and removing it then costs a rewrite and a force push.
- **The archive is append-mostly.** Round records are evidence. Correct a path or a link; do not rewrite what a round concluded.
- **A later copy of a document does not always win.** When the archive and `dev/` both hold a file, read both. The archive's copy may carry hand edits, and the `dev/` copy may be a later state. Keep both under distinct names rather than losing either.
- **`git add` is not a review.** Audit the exact staged set. The `dev/` tree holds credentials and build output that no `.gitignore` in the chan checkout was protecting, because that tree was never meant to be committed anywhere.
