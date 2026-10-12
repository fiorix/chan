# The manual's Devserver page opens scrolled to its embedded demo

Status: raised by the owner on 2026-10-12 from the public site, the day after the manual was split into one page per guide (`f0901774a`, on `main` since `4507fe5a0`); written down, not reproduced by a team, not designed. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction, search or probe named below) is accepted, and nothing past the decision it names.

## What was seen

The owner's words: "on the public website when i click manual -> devserver, it scrolls the page to the place where we have a js widget injected there, instead of just opening the manual at the top of the devserver page".

Read at source on `main` at `4507fe5a0`: `web/packages/marketing/src/pages/manual/devserver.html` embeds the interactive Add devserver demo at line 69 as `<iframe class="launcher-demo-embed" src="/manual/demo/devserver/" loading="lazy">`, well below the top of the page. The framed page is built from `src/templates/demo-embed.html` with `data-variant="devserver"` and mounts the launcher's form through `src/launcher-demo.ts`. The launcher's `Modal.svelte` mounts `createModalFocus` from `@chan/web-shared/modal-focus` on its panel. No scroll or focus call for this page exists in `src/site.js`: the only scroll there keeps the active chapter visible in the mobile navigation strip, horizontally.

Hypothesis, not confirmed in a browser: the demo opens the form as a modal, the modal takes focus when it mounts, and a focus taken inside a frame scrolls the outer page to bring the frame into view. Not established: which browsers and viewport sizes show it; whether the Install page, whose demo is mounted in the page itself and not in a frame, does the same; whether the lazy loading changes when it happens.

## Desired contract

Following a link to a manual page with no fragment opens it at its top, whatever the page embeds. A link with a fragment opens at that heading. The demo still takes focus for its own keyboard handling once the reader interacts with it.

## What to do

Reproduce it first against a built `dist` in a headless browser at a desktop and a phone viewport: load `/manual/devserver/`, wait for the frame to mount, read `window.scrollY`. Find the call that moves the page. Then repair it where it is caused (a mount focus that does not scroll, or no focus until the reader's first interaction with the frame), not by scrolling back afterwards. Check the Install page and the Animations page by the same reading.

## Boundaries

`web/packages/marketing/src/` (the demo embed template, `launcher-demo.ts`, the manual pages), `web/packages/marketing/scripts/smoke-dist.mjs` or a sibling for the check; the launcher's demo mount options if the repair is a mount option. Not changed for the product: the launcher's modal focus behaviour in the desktop app and the workspace window, unless the reproduction shows the same fault there.

## Acceptance

1. The fault reproduced with a number: the scroll offset after load on `/manual/devserver/` with no fragment, per viewport, before the repair.
2. After the repair the offset is zero on every manual page and on `/animations/` with no fragment, in a check that is red on the base and runs with the package's existing smoke.
3. A link with a fragment still lands on its heading.
4. The demo's form is reachable and usable by keyboard after the reader moves focus into it.
5. The repaired site is what the owner reads at `chan.app` after the next deploy of the marketing site, which is the owner's to authorize.
