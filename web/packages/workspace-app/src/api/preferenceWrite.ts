import { ApiError } from "./errors";
import { request } from "./transport";
import type {
  ConfigConflict,
  ConfigPatchRequest,
  GlobalConfig,
  Preferences,
  PreferencesPatch,
} from "./types";

export type PreferencesMutation = (
  preferences: Preferences,
) => PreferencesPatch | null;

const MAX_CONFLICT_RETRIES = 3;
let configWriteInflight: Promise<void> = Promise.resolve();
let writeGeneration = 0;
const pendingEdits = new Set<Promise<void>>();

export function preferenceWriteGeneration(): number {
  return writeGeneration;
}

/// Invalidate older reads as a debounced edit becomes visible. Release the
/// pending edit after enqueuing its write, or when cancelling the debounce.
/// Reads wait for these edits; unrelated writes can still enter the queue.
export function beginPreferenceWrite(): () => void {
  writeGeneration += 1;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  pendingEdits.add(pending);
  return () => {
    pendingEdits.delete(pending);
    finish();
  };
}

/// A read must follow pending edits and queued writes, including work added
/// while it waits. Return the token with that check so the caller's continuation
/// cannot mistake a newly enqueued write for one that already settled.
export async function waitForPreferenceWrites(): Promise<number> {
  for (;;) {
    const pending = configWriteInflight;
    await Promise.all([pending, ...pendingEdits]);
    if (pending === configWriteInflight && pendingEdits.size === 0) return writeGeneration;
  }
}

function isConfigConflict(value: unknown): value is ConfigConflict {
  if (!value || typeof value !== "object") return false;
  const conflict = value as Partial<ConfigConflict>;
  return (
    conflict.code === "config_conflict" &&
    typeof conflict.current?.revision === "number" &&
    !!conflict.current.preferences
  );
}

async function updateWithRetry(mutate: PreferencesMutation): Promise<void> {
  let current = await request<GlobalConfig>("GET", "/api/config");
  for (let retries = 0; ; retries++) {
    const preferences = mutate(current.preferences);
    if (!preferences || Object.keys(preferences).length === 0) return;
    const body: ConfigPatchRequest = {
      expected_revision: current.revision,
      preferences,
    };
    try {
      await request<GlobalConfig>("PATCH", "/api/config", body);
      return;
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !isConfigConflict(error.data) ||
        retries >= MAX_CONFLICT_RETRIES
      ) {
        throw error;
      }
      current = error.data.current;
    }
  }
}

/// Shape traffic through one in-window chain. Correctness comes from the
/// revision compare and conflict replay, so separate windows remain safe.
export function updateGlobalConfigSerial(
  mutate: PreferencesMutation,
): Promise<void> {
  // Invalidate reads at enqueue, including a mutation that later finds the
  // server already holds its value and sends no PATCH or config_changed.
  writeGeneration += 1;
  const result = configWriteInflight
    .catch(() => {})
    .then(() => updateWithRetry(mutate));
  configWriteInflight = result.catch(() => {});
  return result;
}
