# A YouTube embed keeps playing under the screen lock

Status: accepted by the owner on 2026-11-21 as a row of its own ("yes", `dev/v0133/decisions.md`), for v0.134.0. Not started. Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record: the screen lock row pauses every `<video>` and `<audio>` in the page when the lock comes up, by the owner's ruling ("yes media should pause with no auto-resume"). A cross-origin frame is out of the page's reach, so a YouTube embed left playing keeps its sound on a locked screen, though the lock paints over it. Found while that row was built, and left out of it because it changes every embed URL and needs a networked guest to prove.

## What is there now

Read at `v0133/int` `add52591c`; not run.

- A markdown YouTube embed is a sandboxed iframe whose src is `https://www.youtube-nocookie.com/embed/<id>` (`web/packages/workspace-app/src/api/embed.ts:139`), with no player API enabled.
- The lock's media rule is `web/packages/workspace-app/src/state/lockMedia.svelte.ts`. Its header names a cross-origin embed as out of reach.

## Desired contract

1. When the screen lock comes up, a playing YouTube embed pauses and keeps its position.
2. It stays paused after the lock lifts. Nothing resumes it.
3. An embed that starts or is opened while the lock is up does not play.
4. An embed with no lock involved behaves as it does today.

The candidate is YouTube's IFrame Player API: `enablejsapi=1` on the embed URL and a `pauseVideo` command posted to the frame at the lock, with the exact embed origin as the target. Check that it works under the frame's sandbox and the desktop CSP before relying on it.

## Boundaries

- YouTube embeds only. Map embeds have no sound.
- Extension frames are not here: pausing them needs a message contract of their own.
- The screen lock's own UI, PIN and timers are not touched.

## Acceptance

1. A unit test for the embed URL and for the command posted at the lock, each killed by a named mutation.
2. An end-to-end reading in a networked guest with a real embed: playing at lock time, paused under the lock, still paused at its position after unlock, and an embed opened under the lock does not play. Red at the base.
3. The same reading in chan-desktop on the owner's Mac, since WKWebView is where the embed's frame policy differs.
