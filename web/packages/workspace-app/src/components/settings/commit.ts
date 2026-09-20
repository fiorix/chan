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

export type CommitFn = (
  mutate: (p: Preferences) => Preferences,
  persist?: () => Promise<unknown>,
) => void;
