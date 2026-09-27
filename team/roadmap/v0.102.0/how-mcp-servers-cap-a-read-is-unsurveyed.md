# How other MCP servers answer a read of a file over their cap is not surveyed

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised by the owner the same day, with the acceptance of the read's bound in [an-mcp-read-loads-the-whole-file-before-its-cap](../v0.101.0/an-mcp-read-loads-the-whole-file-before-its-cap.md). Nothing is read or run yet.

## Owner ruling

Accepted on 2026-09-27 for the next version, at the owner's own request: accepting a stat before the read for chan's two reading tools, the owner asked in the same answer for an investigation of how other MCP servers handle a read of a file over their cap. It is not part of v0.101.0.

## What is asked

A survey of other MCP servers that read files for a client. For each server, what it answers for a file over its cap: a refusal, a cut text, or the whole file; whether it reads the file before it refuses or cuts it, or learns the file's size first; and whether it offers a range or a page of a file, so that a client can read a large file in parts.

## Acceptance

1. A written comparison of the servers surveyed, with the three answers for each and where each was read: the server's source or its documentation, at a named version.
2. A recommendation for chan's tools: whether the bound [an-mcp-read-loads-the-whole-file-before-its-cap](../v0.101.0/an-mcp-read-loads-the-whole-file-before-its-cap.md) builds is enough, and whether chan's reads should offer a range or a page.
