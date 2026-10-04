// Two questions about localStorage that several modules ask: whether the
// store takes a write at all, and what an on/off flag kept in it says. A leaf
// module with no imports, so any module can import it without a cycle.

/// Whether localStorage exists and takes a write. A store can exist and
/// still throw on `setItem` (a full quota, a denied store), so the probe
/// writes `probeKey` and removes it. Each caller passes a key of its own.
export function isStorageAvailable(probeKey: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

/// The on/off flag stored under `key`: "0", "off" and "false" read false,
/// "1", "on" and "true" read true, and anything else, an unset key included,
/// reads `fallback`. A missing store or a read that throws reads false,
/// whatever `fallback` is.
export function readStorageFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const v = localStorage.getItem(key);
    if (v === "0" || v === "off" || v === "false") return false;
    if (v === "1" || v === "on" || v === "true") return true;
  } catch {
    return false;
  }
  return fallback;
}
