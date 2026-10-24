# chan-desktop has a setting for its client session name

Status: raised for v0.110.0 on 2026-10-23 by the owner; not started.

## What was asked

The owner's words of 2026-10-23, on how a client's session name is set: "i dont know if we already do have a config for setting the chan-desktop name but we could add one too, with a default value empty resulting in auto-naming as of today", then "let's do the cs session self --name X part and leave the desktop setting alone, we can add that as an item in the roadmap for the next version". v0.109.0 ships `cs session self --name X`, which names the calling client and its window's participant for the server process's life; chan-desktop has no name setting (`desktop/src-tauri/src/config.rs`).

## Desired contract

A chan-desktop setting names the desktop's client session; empty, the default, keeps the generated name as today. The desktop presents the name when it connects, so it holds across a server restart; `cs session self --name` and `--reset` still override it for the server process's life, and the name passes the same refusals as `cs session self --name`.

## What to do

First step, a short design: the setting's key and place in the desktop config, how the name reaches the server at connect (a socket query, a header or a request), and its order against a `cs session self --name` already made; then the change with its tests.

## Acceptance

1. A named desktop appears under that name in `cs session list` after connecting and after the server restarts.
2. An empty setting keeps the generated name; an invalid one is refused with the same message as `cs session self --name`.
