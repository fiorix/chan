# Windows signing has no early credential probe

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's Windows signing leftovers and the rc1 signing diagnosis (`dev/v0100-team/evidence/lead/rc1-release-35821827608/signing-diagnosis.md`, proposal C). A source reading against `main` at `6237c2677`.

## What was seen

A trust or credential failure in the Windows signing job surfaces only at the first `sign.ps1` call, after the release build, because nothing exercises CodeSignTool right after it is installed. A probe was not added because CodeSignTool's release notes document no credential-listing command.

## What to do

If SSL.com documents a command that authenticates without signing (such as listing credential ids), run it right after the install step and fail on missing output; otherwise leave this closed with that reason.
