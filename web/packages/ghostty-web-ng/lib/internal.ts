// The widget's private state, for the package's own white-box tests: what a
// test sets up or reads that no public member reaches. A class's `#private`
// members can be reached only from its own body, so each class hands this
// module a reader from a static block.
//
// Nothing in the package's export map reaches this module and the app's
// boundary check refuses an import of any path past that map, so its only
// importers are the tests beside the widget.

import type { SelectionAnchor, SelectionManager } from './selection-manager';

/// A selection's two endpoints as the manager keeps them: writing one
/// replaces that endpoint's tracked cell, reading one resolves it first.
export type SelectionEndpoints = { start: SelectionAnchor | null; end: SelectionAnchor | null };

let readSelection: ((manager: SelectionManager) => SelectionEndpoints) | undefined;

export function registerSelectionInternals(read: (manager: SelectionManager) => SelectionEndpoints): void {
  readSelection = read;
}

export function selectionInternals(manager: SelectionManager): SelectionEndpoints {
  if (!readSelection) throw new Error('SelectionManager registered no reader');
  return readSelection(manager);
}
