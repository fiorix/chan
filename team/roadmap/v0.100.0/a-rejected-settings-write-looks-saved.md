# A rejected settings write looks saved

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding SET-01 high, SET-03 medium), re-verified against `main` at `d3de0180b` by reading.

## What was seen

`web/packages/workspace-app/src/components/SettingsOverlay.svelte` runs each write as `void Promise.resolve(run).finally(...)` with no `catch`. Its only error state, `loadError`, covers the initial GET. Any rejected `PATCH /api/config` (a 400, a 5xx, offline, an exhausted conflict replay in `api/preferenceWrite.ts`) therefore becomes an unhandled rejection with no message, and the optimistic buffer keeps showing the value the server refused until something reseeds it. Two callers make it worse by returning `Promise.resolve()` while dropping the real write's promise: `components/settings/GlobalSection.svelte` and `components/settings/SurfaceThemeField.svelte`.

Next to it, `components/settings/ColorField.svelte` commits on every `input` event of the native colour picker, so one drag enqueues a GET plus a PATCH of the whole config per intermediate colour, serialized behind one chain, which is also the easiest way to hit the failure above.

## Desired contract

A settings write that fails is visible on the field that failed, and the field shows the server's value again. A control commits once per user decision, not once per intermediate value.

Whether the unused `SaveStatus` vocabulary becomes the way every settings write reports, or a generic notice is enough, is an owner ruling; the review recommends the first.

## Boundaries

`web/packages/workspace-app/src/components/SettingsOverlay.svelte`, `components/settings/GlobalSection.svelte`, `components/settings/SurfaceThemeField.svelte`, `components/settings/ColorField.svelte`, and tests (`components/SettingsOverlay.render.test.ts`, a new `ColorField` test). No server change: a locked configuration already answers 403 and that answer is what has to become visible.

## Acceptance

1. A `PATCH /api/config` answered 400 shows an error on that field and restores the server's value, with no unhandled rejection.
2. The same for the two custom-persist callers.
3. One drag through the colour picker issues one write.
