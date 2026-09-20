import type { Preferences } from "../../api/types";

// A single-field settings write. `mutate` returns the preferences with
// one slice changed; `persist`, when a field has a dedicated store/api
// setter (theme), runs that instead of the generic serial PATCH. The
// parent surface owns the optimistic apply and the in-flight guard, so a
// section stays purely presentational.
/// How a settings write reports itself. Every control that writes says
/// where it is in this vocabulary, so a refusal is visible where the
/// user made the change rather than as a notice with no field attached.
export type SaveStatus = "idle" | "saving" | "saved" | { error: string };

/// A control that renders its own status asks for `ownStatus`, and the
/// write is then not attributed to the fields presenting its
/// preferences. Several colour rows write one preference, so the
/// preference cannot say which row was refused; the row can.
export type CommitOptions = { ownStatus?: boolean };

/// Hands back where the write ended, so a control that asked to report
/// for itself has something to report. It never rejects: a refusal is
/// the `{ error }` value.
export type CommitFn = (
  mutate: (p: Preferences) => Preferences,
  persist?: () => Promise<unknown>,
  options?: CommitOptions,
) => Promise<SaveStatus>;

/// Where the save statuses live for the fields of one settings surface.
/// The surface owns the writes, so it owns the statuses; a field asks
/// for its own by the preferences key it presents, and gets "idle" when
/// nothing has been written to that key or when there is no surface
/// above it (a control mounted on its own in a test).
export const SAVE_STATUS = Symbol("settings-save-status");

export type SaveStatusLookup = (pref: string) => SaveStatus;
