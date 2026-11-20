# A tour part the pointer crossed stays lit

Status: Accepted for v0.133.0 by the owner on 2026-11-20 ("web marketing: once we hover over one of the terminal windows / videos, they get marked as selected and there's no way to deselect them; i want to be able to deselect by clicking away from it"); built and reviewed: the fix, `scripts/e2e/315-marketing-tour-rest.mjs` red at the base and green at the tip in a Chrome guest, one reader accepting with notes. Open for the owner: a touch scroll that starts off a part also rests the awake part, since the rest listens for the press.

Record: reported by the owner on 2026-11-20 from the chan.app home page. Not reproduced by a run before this row; the reading below is from the source.

## What is there now

Read at `793d86522`, by reading; not run. Paths are under `web/packages/marketing/src/`.

- The home page's tour (`pages/home.html:2`) draws its scene in a pinned stage. Regions of the scene are links that name a part (`a[data-part]`): the computers' pads (`:22-25`), the library's tiles and its tag (`:38-41`, `:44`), the window captures' regions (`:53-54`, `:64-67`, `:73-74`) and the Window tag (`:76`). The stage holds one callout for them (`:81`): a title, a line and an "In the manual" link. The stepped figures on `pages/manual.html` and `pages/manual/concepts.html` are tours with no parts.
- `tour.ts` keeps one awake part (`awake`, `:54`). `wake(part)` (`:58-69`) moves the `is-awake` class to that part, unhides the callout and fills it from the part's `data-part`, `data-line` and `href`; `wake(null)` takes the class off and hides the callout.
- A part wakes when a mouse pointer enters it (`:215-217`, `pointerenter` with `pointerType` "mouse") and on a first click or tap (`:218-222`, which prevents the link); a click on the part already awake follows its link.
- The only `wake(null)` is in `setBeat` (`:92`), so a part rests when the tour moves to another beat. Nothing else rests it: a part the mouse merely crossed on its way across the page keeps its outline and the callout until the reader scrolls to another beat or another part wakes, and a press or tap anywhere else does nothing.
- The awake styles are in `tour.css`: `.scene-layer a.is-awake` (`:69`), `.scene-layer > .scene-tag.is-awake` (`:93`) and `.shot-win .shot-part.is-awake` (`:113`); the callout is `.tour-callout` (`:44-47`), hidden by its `hidden` attribute.

## Desired contract

1. A press anywhere that is not a part puts the awake part back to rest: no outline, no callout. A tap does the same.
2. The callout belongs to the awake part. A press inside it, on its text or on its link, keeps the part awake, so the link follows to that part's page and the text can be read or selected without losing the reader's place.
3. Everything else stays: the mouse entering a part wakes it, a click on a part already awake follows its link, a first tap on a part wakes it without following, a beat change rests the part, and the tour's beats and the stepped figure's autoplay rest and resume as today.

## Boundaries

- `tour.ts`, and `tour.css` only if a state needs it.
- The part does not rest when the pointer leaves it, and Escape does not rest it. Neither was asked, and neither is built; the owner may want either later.

## Acceptance

1. A browser check over the built marketing site in Chrome, on each page whose tour has parts, at a desktop viewport: (a) the mouse over a part lights it and the callout shows that part's title; (b) a press on empty stage clears both; (c) after the mouse wakes it again, a press outside the tour clears both; (e) a click on a part already awake follows its link; (f) a press inside the callout keeps the part awake and its link follows to the part's page. At a phone viewport with touch: (d) a tap on a part wakes it without following its link, and a tap elsewhere clears it.
2. The check is red at `793d86522` on (b), (c) and the second half of (d) only, and green with the fix. Each leg asserts that the tour stayed on one beat, so a beat change cannot clear the part for it.
