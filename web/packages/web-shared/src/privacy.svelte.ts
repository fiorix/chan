// Viewing-client policy. The desktop owns it across origins; ordinary browser
// pages share it only with other pages on their own origin.
type Settings = { enabled: boolean; mask_terminal_secrets: boolean; revision: number };
type Patch = Partial<Pick<Settings, "enabled" | "mask_terminal_secrets">>;
type Bridge = {
  state: Settings;
  ready: boolean;
  error: string;
  set(patch: Patch): Promise<void>;
  refresh(): Promise<void>;
};

const STORAGE = "chan.privacy.v1";
const REVEALS = "chan.privacy.reveals.v1";
const host = typeof window === "undefined" ? undefined : window as Window & { __CHAN_PRIVACY__?: Bridge };
const bridge = host?.__CHAN_PRIVACY__;

function stored(): Settings {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE) ?? "null");
    if (value && typeof value.enabled === "boolean" && typeof value.mask_terminal_secrets === "boolean" && Number.isSafeInteger(value.revision)) return value;
  } catch { /* Storage may be unavailable in a browser. */ }
  return { enabled: false, mask_terminal_secrets: false, revision: 0 };
}

function storedReveals(): Record<string, number> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(REVEALS) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Reveals remain local to this page without session storage. */ }
  return {};
}

export const privacy = $state({
  ...(bridge?.state ?? stored()),
  ready: bridge?.ready ?? true,
  error: bridge?.error ?? "",
  saving: false,
});
let reveals = $state<Record<string, number>>(storedReveals());

function adopt(): void {
  Object.assign(privacy, bridge?.state ?? stored(), {
    ready: bridge?.ready ?? true,
    error: bridge?.error ?? "",
  });
}

// These listeners own no resources beyond their document's lifetime.
host?.addEventListener("chan:privacy-change", adopt);
host?.addEventListener("storage", (event) => {
  if (!bridge && (event.key === STORAGE || event.key === null)) adopt();
});

export async function setPrivacy(patch: Patch): Promise<void> {
  privacy.saving = true;
  privacy.error = "";
  try {
    if (bridge) await bridge.set(patch);
    else {
      const previous = stored();
      window.localStorage.setItem(STORAGE, JSON.stringify({ ...previous, ...patch, revision: previous.revision + 1 }));
    }
    adopt();
  } catch {
    privacy.error = "Could not save privacy settings. Your previous setting is still in use.";
  } finally {
    privacy.saving = false;
  }
}

export function retryPrivacy(): void { void bridge?.refresh(); }

export function isConcealed(key: string): boolean {
  return privacy.enabled && (!privacy.ready || reveals[key] !== privacy.revision);
}

export function toggleReveal(key: string): void {
  if (!privacy.ready) return;
  reveals = { ...reveals, [key]: isConcealed(key) ? privacy.revision : -1 };
  try { window.sessionStorage.setItem(REVEALS, JSON.stringify(reveals)); } catch { /* Page-local reveal still works. */ }
}

/** Secondary labels and tooltips never reveal a primary field implicitly. */
export function privateText(value: string | null | undefined, replacement = "Hidden"): string {
  return privacy.enabled && value ? replacement : value ?? "";
}
