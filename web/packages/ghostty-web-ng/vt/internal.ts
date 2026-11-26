// The binding's private state, for the package's own white-box tests: the
// allocator, core handles and reply sinks a leak or layout test counts,
// which no public member shows. A class's `#private` fields can be read
// only from its own body, so each class hands this module a reader from a
// static block.
//
// Nothing in the package's export map reaches this module and the app's
// boundary check refuses an import of any path past that map, so its only
// importers are the tests beside the binding.

import type { GhosttyVt, VtSearch, VtTerminal, VtTrackedCell } from "./ghosttyVt";

/// A wasm instance as a test reaches it: the exports it calls or replaces,
/// and the allocator it watches.
export type InternalWasm = {
  readonly fn: Record<string, (...args: any[]) => any>;
  readonly memory: WebAssembly.Memory;
  bytes(): Uint8Array;
  view(): DataView;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
};

/// A terminal's private state at the moment it is read.
export type TerminalInternals = {
  readonly wasm: InternalWasm;
  readonly handle: number;
  readonly scratch: number;
  readonly writeBuf: number;
  readonly writeCap: number;
  readonly trackedCells: ReadonlySet<VtTrackedCell>;
};

/// A search's private state.
export type SearchInternals = { readonly wasm: InternalWasm; readonly handle: number };

/// A `GhosttyVt`'s private state: the reply sink it holds for each live
/// terminal, by the terminal's core handle.
export type BindingInternals = {
  readonly replySinks: ReadonlyMap<number, (ptr: number, len: number) => void>;
};

let readBinding: ((vt: GhosttyVt) => BindingInternals) | undefined;
let readTerminal: ((t: VtTerminal) => TerminalInternals) | undefined;
let readSearch: ((s: VtSearch) => SearchInternals) | undefined;

export function registerBindingInternals(read: (vt: GhosttyVt) => BindingInternals): void {
  readBinding = read;
}

export function registerTerminalInternals(read: (t: VtTerminal) => TerminalInternals): void {
  readTerminal = read;
}

export function registerSearchInternals(read: (s: VtSearch) => SearchInternals): void {
  readSearch = read;
}

export function bindingInternals(vt: GhosttyVt): BindingInternals {
  if (!readBinding) throw new Error("GhosttyVt registered no reader");
  return readBinding(vt);
}

/// `t`'s private state now; a later write or allocation can move it, so
/// read it again after one.
export function terminalInternals(t: VtTerminal): TerminalInternals {
  if (!readTerminal) throw new Error("VtTerminal registered no reader");
  return readTerminal(t);
}

export function searchInternals(s: VtSearch): SearchInternals {
  if (!readSearch) throw new Error("VtSearch registered no reader");
  return readSearch(s);
}
