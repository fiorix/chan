// The machine preferences as this window shows them outside the Settings
// overlay, and the write that changes them from there.
//
// The served record follows a write only after its round trip: the PATCH,
// the `config_changed` frame and the refresh behind it. A row that showed
// the old value for that long would flip late, and a second press inside
// the gap would read the stale value and send the first one again. So a
// write is applied over the served record from the moment it is asked for
// until the server's next record replaces it.

import type { Preferences, PreferencesPatch } from "../../api/types";
import { currentPreferences, updateGlobalConfigSerial } from "../../state/store.svelte";

/// One change to a preferences record, returning the changed record. It may
/// run more than once: over the shown record, and again over the server's
/// when a write is replayed after a conflict.
export type PreferencesChange = (preferences: Preferences) => Preferences;

type Write = {
  change: PreferencesChange;
  /// The record the window held when the server answered the write, or
  /// undefined while it has not. The write stands until that record is
  /// replaced.
  answeredOver?: Preferences | null;
};

let writes = $state.raw<readonly Write[]>([]);

export function clonePreferences(preferences: Preferences): Preferences {
  return JSON.parse(JSON.stringify(preferences)) as Preferences;
}

/// The slice of `current` that `change` alters, as the body of a config
/// write, or null when it alters nothing.
export function changePatch(
  current: Preferences,
  change: PreferencesChange,
): PreferencesPatch | null {
  const next = change(clonePreferences(current));
  const changed = Object.entries(next).filter(
    ([key, value]) =>
      JSON.stringify(current[key as keyof Preferences]) !== JSON.stringify(value),
  );
  return changed.length > 0 ? (Object.fromEntries(changed) as PreferencesPatch) : null;
}

function standing(served: Preferences | null): readonly Write[] {
  return writes.filter(
    (write) => write.answeredOver === undefined || write.answeredOver === served,
  );
}

/// The preferences to show: the served record with every standing write
/// applied, or null while the window has been served none.
export function shownPreferences(): Preferences | null {
  const served = currentPreferences();
  if (!served) return null;
  const pending = standing(served);
  if (pending.length === 0) return served;
  return pending.reduce((shown, write) => write.change(shown), clonePreferences(served));
}

/// Write one change to the machine preferences and show it at once. `persist`
/// replaces the generic patch for a field with a setter of its own. Rejects
/// with the server's refusal, and the shown value then falls back to the
/// served one.
export async function writePreferences(
  change: PreferencesChange,
  persist?: () => Promise<unknown>,
): Promise<void> {
  const write: Write = { change };
  writes = [...standing(currentPreferences()), write];
  try {
    await (persist
      ? persist()
      : updateGlobalConfigSerial((preferences) => changePatch(preferences, change)));
  } catch (error: unknown) {
    writes = writes.filter((other) => other !== write);
    throw error;
  }
  const served = currentPreferences();
  writes = standing(served).map((other) =>
    other === write ? { change, answeredOver: served } : other,
  );
}

/// Forget every standing write, so a test starts from the served record.
export function resetShownPreferencesForTests(): void {
  writes = [];
}
