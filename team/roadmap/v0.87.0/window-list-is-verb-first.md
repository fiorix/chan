# Acting on a window means picking the verb before you can see the windows

Status: REGISTERED 2026-08-09 for v0.87.0, from comparing the command launcher's Computers scope against chan-desktop's own native Window menu. IMPLEMENTED 2026-08-09 in `23ab509f`, owner-tested on the round build.

## What

chan-desktop's Window menu is target-first. It lists windows in sections -- open windows, one section per devserver, hidden, remote -- and a click raises, unburies, or reopens the one you picked. You look at what exists, then act.

The command launcher inverts that. `Focus`, `Hide`, `Show`, and `Close` are four sibling branches under Computers, each drilling into its own filtered copy of the same roster. Closing a window means committing to "close" before the launcher will tell you which windows there are, and one window can appear in as many as four different lists with no indication they are the same window. The four branches also disagree with each other about what exists: the workspace app's `Focus` lists every window while its other three are owner-only and drop control terminals, so the roster silently changes shape as you move between siblings.

The verb-first shape also makes the two decks look more different than they are. The launcher SPA lets a control terminal be hidden and closed because it acts through the desktop bridge; the workspace app cannot, because the capability route refuses both. Today that divergence is buried inside four filter predicates. Target-first, it is one window offering different actions.

## Contract

- Computers lists the windows that exist, once each. Choosing one shows the actions that window can take.
- The actions offered on a window are the actions that will actually succeed on it: a control terminal on a capability surface offers no mutation, a readonly grantee offers no mutation anywhere, and a hidden window is shown rather than focused.
- Open and hidden are visible on every row without opening anything.
- Typed search still reaches an action in one keystroke sequence. Searching a verb plus a window name lands on that action, not merely on the window.
- A window that closes while its actions are on screen returns the deck to the window list rather than an empty body.

## Acceptance

- The Computers root has one `Windows` branch and no `Focus` / `Hide` / `Show` / `Close` siblings, in both the workspace app and the chan-desktop launcher.
- Every window in the invoking library, or on every machine in the desktop launcher, appears exactly once in that list, ordered as the Library screen orders it.
- Descending into a window and pressing ArrowLeft returns to the window list, not to the Computers root.
- `focus <window caption>` still focuses that exact window from the root, with no submenu opened.

## Rough size

Small, and confined to the two deck adapters. The shared `CommandDeck` is unchanged: it already accepts a multi-element navigation path, and it gains no grouping primitive, since open-versus-hidden rides the breadcrumb each row already carries.

## Implemented 2026-08-09 (`23ab509f`)

One `Windows` branch replaces the `Focus` / `Hide` / `Show` / `Close` quartet in both decks. Choosing a window offers the actions that window can take: a hidden window is shown rather than focused where the two would be the same click, a control terminal on the capability surface offers no mutation because `set_window_visibility` and `close_window` both refuse one server-side, and a readonly grantee gets `Focus` alone. The desktop launcher keeps `Show` beside `Focus`, since its `Show` is a plain visibility flip that does not take focus, and it orders the list through the machine tree the Library screen already uses.

Open versus hidden rides each row's breadcrumb rather than a section header: the shared deck is a flat listbox whose arrow keys land on disabled rows, so inert headers would be dead stops in the keyboard path. The window rows are branches now, so the flattened search list carries every window's actions too, keeping a verb query one Enter from acting. A window that closes while its actions are on screen drops the deck back to the list; the workspace app's recovery only fired once a selection was lost, and the launcher had none.

Both decks navigate a two-element path where they only ever wrote one. The draft model already permitted it and `back()` already popped one level at a time, so this changed the readers alone and the shared `CommandDeck` is untouched.

Validation: svelte-check clean on both packages, vitest 3646 + 318 green, production build clean. Six mutation probes, each failing exactly the test that claims it: making control terminals manageable, dropping the hidden-window `Show` swap, giving a readonly role the owner mutations, removing the vanish recovery, detaching the window order from the machine tree, and dropping the action leaves from typed search.
