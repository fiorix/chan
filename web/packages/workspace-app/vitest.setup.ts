// Environment shim for the vitest jsdom runs.
//
// A newer Node ships storage globals of its own, and they take precedence
// over the ones vitest's jsdom environment installs. Node 24+ has a built-in
// `localStorage`: an accessor on `globalThis` that yields `undefined` unless
// the process gets `--localstorage-file`, so every test that drives a
// persistence seam reads `undefined` and dies in its own `beforeEach`. Node
// 26 also has a built-in `sessionStorage` that works, but it is an instance
// of Node's own `Storage` class while the global `Storage` is still the
// page's: a spy on `Storage.prototype` then sees none of its writes, an
// assertion that something was written fails, and one that nothing was
// written passes without looking.
//
// CI runs the Node major the root `.nvmrc` declares; while that is below 24
// this only bites a local run on a newer Node, which is the worst shape for a
// gate: the pre-push run disagrees with the run that decides the merge. Put
// the page's own stores back wherever the environment has them, and install
// a Storage where it has none, so the suite reads the same under every Node
// the gate runs on.

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
