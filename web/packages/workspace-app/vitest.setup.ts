// Environment shim for the vitest jsdom runs.
//
// Node 24+ ships a built-in `localStorage` global. It is an accessor on
// `globalThis` that yields `undefined` unless the process gets
// `--localstorage-file`, and it takes precedence over the Storage that
// vitest's jsdom environment installs (`sessionStorage`, which Node does not
// claim, comes through as a real jsdom Storage). Every test that drives a
// persistence seam then reads `undefined` and dies in its own `beforeEach`.
//
// CI pins Node 20, so this only bites locally, which is the worst shape for a
// gate: the pre-push run disagrees with the run that decides the merge. Install
// a Storage whenever the environment fails to supply a working one so the suite
// reads the same under every Node the gate runs on.

/// The Storage surface the SPA actually uses: `getItem`, `setItem`,
/// `removeItem`, `clear`, `length`, and `key`. Insertion order carries the
/// `key(index)` ordering, matching what browsers and jsdom do for a store that
/// was only ever written through `setItem`.
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  key(index: number): string | null {
    if (!Number.isInteger(index) || index < 0) return null;
    return [...this.#entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  clear(): void {
    this.#entries.clear();
  }

  [name: string]: unknown;
}

function storageIsUsable(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const storage = candidate as Partial<Storage>;
  return typeof storage.getItem === "function" && typeof storage.setItem === "function";
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (storageIsUsable(globalThis[name])) continue;
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}
