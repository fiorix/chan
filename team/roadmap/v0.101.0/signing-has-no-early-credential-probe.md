# Windows signing has no early credential probe

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Windows signing leftovers and the rc1 Windows signing diagnosis of release dry run `35821827608`, proposal C. A source reading against `main` at `6237c2677`.

## What was seen

A trust or credential failure in the Windows signing job surfaces only at the first `sign.ps1` call, after the release build, because nothing exercises CodeSignTool right after it is installed. A probe was not added because CodeSignTool's release notes document no credential-listing command.

## What to do

If SSL.com documents a command that authenticates without signing (such as listing credential ids), run it right after the install step and fail on missing output; otherwise leave this closed with that reason.

## What shipped

SSL.com's eSigner CodeSignTool command guide documents `get_credential_ids` and `credential_info`, which authenticate without signing, so the item's premise that no such command exists was wrong. A probe step right after the CodeSignTool install in `release.yml` and `release-desktop.yml` runs `get_credential_ids` from the tool root and fails unless the listing names `CREDENTIAL_ID`; the verdict is the listing, since the tool exits 0 on failure, and no tool output is printed. It covers TLS trust, username, password and credential id, not the TOTP secret, which still fails at the first signed file. The step is unexercised until the next dispatched release run.
