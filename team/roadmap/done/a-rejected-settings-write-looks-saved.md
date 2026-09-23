# A rejected settings write looks saved

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A rejected settings write shows on its field, which returns to the server's value, and every settings write reports through one `SaveStatus` vocabulary.

## What was seen

`web/packages/workspace-app/src/components/SettingsOverlay.svelte` runs each write as `void Promise.resolve(run).finally(...)` with no `catch`. Its only error state, `loadError`, covers the initial GET. Any rejected `PATCH /api/config` (a 400, a 5xx, offline, an exhausted conflict replay in `api/preferenceWrite.ts`) therefore becomes an unhandled rejection with no message, and the optimistic buffer keeps showing the value the server refused until something reseeds it. Two callers make it worse by returning `Promise.resolve()` while dropping the real write's promise: `components/settings/GlobalSection.svelte` and `components/settings/SurfaceThemeField.svelte`.

Next to it, `components/settings/ColorField.svelte` commits on every `input` event of the native colour picker, so one drag enqueues a GET plus a PATCH of the whole config per intermediate colour, serialized behind one chain, which is also the easiest way to hit the failure above.

## Desired contract

A settings write that fails is visible on the field that failed, and the field shows the server's value again. A control commits once per user decision, not once per intermediate value.

Owner ruling, 2026-09-20: every settings write reports through the `SaveStatus` vocabulary (`"idle" | "saving" | "saved" | { error }`), as the review recommends. A generic notice is not the report. The type is declared twice today, in `components/HybridSurfaceConfigShell.svelte` and `components/settings/workspace/ExcludedDirsControl.svelte`, and gets one declaration.

## Boundaries

`web/packages/workspace-app/src/components/SettingsOverlay.svelte`, `components/settings/GlobalSection.svelte`, `components/settings/SurfaceThemeField.svelte`, `components/settings/ColorField.svelte`, and tests (`components/SettingsOverlay.render.test.ts`, a new `ColorField` test). No server change: a locked configuration already answers 403 and that answer is what has to become visible.

The ruling reaches further than that list. A vocabulary every field speaks cannot live in three files when the fields live in seven, so `components/settings/SettingField.svelte` carries the status and `BrowserSection`, `EditorSection`, `GraphSection`, `SearchSection` and `TerminalSection` declare which preference each field writes, with `components/settings/commit.ts` beside them. A colour swatch reports on itself for the same reason: the status is a context keyed by preference key and `ColorField` knows only a DOM id, so its call site has to name the preference. The three theme setters in `state/store.svelte.ts` and `persistHybridSurfaceThemes` belong to the item too, because an optimistic apply that is never rolled back is how a refused write reaches the server inside the next one.

## Acceptance

1. A `PATCH /api/config` answered 400 shows an error on that field and restores the server's value, with no unhandled rejection.
2. The same for the two custom-persist callers.
3. One drag through the colour picker issues one write.
