# Three inputs have no size cap

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Rust-lows follow-up (worklist L77, L133 and L139, the sizing findings); each needs an owner decision on the limit before a patch. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended, which sets the limits the item asked the owner for, as the starting point the lane checks against the code's existing budgets: archive extraction at 10,000 entries and 256 MiB decompressed; a scene WebSocket message at 16 MiB, below tungstenite's 64 MiB default, with the scene budget deciding the rest; and 256 subscriptions per socket. Each refusal is named and pinned at and past its limit.

## What was seen

`extract_payload` (`crates/chan-workspace/src/metadata_archive.rs:732`) extracts a metadata archive with no cap on entry count or decompressed size (L77). `api_scene_ws` (`crates/chan-server/src/routes/scene.rs:172`, upgrade at `:183`) accepts tungstenite's default 64 MiB message, and the scene budget applies only after a full parse (L133). `apply_client_frame` (`crates/chan-server/src/routes/ws.rs:393`, subscribe at `:404`) has no cap on scope subscriptions per socket, so a client can grow server state and OS watch attempts without bound (L139).

## What to do

The owner sets a limit for each (archive entries and bytes, a scene message size, subscriptions per socket); each is then enforced where the input arrives, refused with a named error, and pinned by a test at the limit and one past it.
