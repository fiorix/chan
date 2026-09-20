# Rich copy puts the session bearer token on the clipboard

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding WSIO-01, high), re-verified against `main` at `d3de0180b`. A static trace with every hop read; not reproduced in a browser, because the jsdom test has no token.

## What was seen

On a token-protected server, which is the default, copying a WYSIWYG selection that contains a workspace image sets a `text/html` clipboard flavor whose `<img src>` is `http://host:port/api/fs/notes/a.png?t=<bearer>`. Pasting into a mail client, a chat or a document ships the live session bearer into that message.

The path is `renderBody` in `web/packages/workspace-app/src/editor/copy_html.ts` calling `toAbsoluteUrl(resolveImageSrc(...))`; `resolveImageSrc` goes through `withTokenQuery` in `api/client.ts`, and `api/transport.ts` appends `?t=`. `toAbsoluteUrl` keeps the query, the markup is serialized and set as `text/html`, and the same payload is handed to the desktop clipboard bridge. The asynchronous upgrade to `data:` URIs only replaces the sources it fetches inside its 20 MiB budget, so a failed fetch, an over-budget image or a rejected upgrade leaves the tokenized URL in the final payload.

Everywhere else the app treats that token as sensitive: `transport.ts` deletes `t` from the address bar on load. The consequence is highest for a window served through the tunnel, where the pasted URL is a working credential from anywhere.

The same channel reaches more sinks than this one. `withTokenQuery` has about fourteen production call sites behind two wrappers (video sources, embeds, download URLs, the drag-and-drop payload), and nothing states which sinks a token-bearing URL may reach.

## Desired contract

A URL carrying the session token never leaves the app. Rich copy writes image URLs without the token, so an external consumer gets a 401 image and the `data:` upgrade stays the mechanism that makes an external paste render. The rule is written next to `withTokenQuery`: which sinks may receive a token-bearing URL, and that the clipboard, the drag payload and any exported document are not among them.

## Boundaries

`web/packages/workspace-app/src/editor/copy_html.ts` (`toAbsoluteUrl`, and the module comment that says "tokenized" while `copy_html.test.ts` says "tokenless"), `copy_html.test.ts`, and the doc comment on `withTokenQuery` in `api/client.ts`. Auditing the other sinks is part of this item; changing how media is authorized is not. The chan-to-chan paste path is unaffected, because `uploadForeignRefs` in `paste_html.ts` already refuses any source that is not a `data:` URI.

## Acceptance

1. A test runs rich copy with a token present and asserts no `t=` parameter in the `text/html` payload, in the baseline and after a failed, over-budget and rejected upgrade.
2. The desktop clipboard bridge receives the same tokenless payload.
3. Each remaining `withTokenQuery` sink is listed in the item's evidence with a verdict: stays in the app, or leaves it and is fixed here.
4. The rule sits on `withTokenQuery`, and the module comment and the test name agree.
