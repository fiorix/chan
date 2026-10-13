// Environment shim for the vitest jsdom runs.
//
// Node 24+ can install storage globals ahead of jsdom's. Its localStorage
// is unusable without --localstorage-file; under Node 26, its sessionStorage
// works but is not the page's Storage. A Storage.prototype spy then misses
// writes through that global.
//
// Restore the page's stores when available. Preserve a usable global if the
// page has none, and use MemoryStorage only when neither is usable.

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

type StorageName = "localStorage" | "sessionStorage";

/// The jsdom page's own store, when the test runs in a jsdom environment
/// whose origin has one.
function pageStorage(name: StorageName): Storage | undefined {
  try {
    const page = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
    const storage = page?.[name];
    return storageIsUsable(storage) ? storage : undefined;
  } catch {
    // An opaque origin has no storage, and jsdom throws on the read.
    return undefined;
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  const page = pageStorage(name);
  if (page ? globalThis[name] === page : storageIsUsable(globalThis[name])) {
    continue;
  }
  Object.defineProperty(globalThis, name, {
    value: page ?? new MemoryStorage(),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}
