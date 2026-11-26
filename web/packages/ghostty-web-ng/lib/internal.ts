// The widget's private state, for the package's own white-box tests: what a
// test sets up or reads that no public member reaches. A class's `#private`
// members can be reached only from its own body, so each class hands this
// module a reader from a static block.
//
// Nothing in the package's export map reaches this module and the app's
// boundary check refuses an import of any path past that map, so its only
// importers are the tests beside the widget.

import type { VtTerminal } from '../vt/ghosttyVt';
import type { EventEmitter } from './event-emitter';
import type { TerminalChange } from './interfaces';
import type { LinkDetector } from './link-detector';
import type { CanvasRenderer } from './renderer';
import type { SelectionAnchor, SelectionManager } from './selection-manager';
import type { Terminal } from './terminal';

/// A terminal's private state a test sets up or reads: the core, renderer,
/// canvas, open state and link detector `open` wires, which the viewport
/// tests set on a terminal they assemble around a stub renderer; the
/// viewport offset, which only `renderer.redraw.test.ts` sets, below the
/// zero the terminal clamps its own offset at; a smooth scroll in flight;
/// and the parts the terminal delivers changes and selections through.
export type WidgetInternals = {
  wasmTerm: VtTerminal | undefined;
  renderer: CanvasRenderer | undefined;
  viewportY: number;
  canvas: HTMLCanvasElement | undefined;
  isOpen: boolean;
  linkDetector: LinkDetector | undefined;
  targetViewportY: number;
  scrollAnimationStartTime: number | undefined;
  scrollAnimationFrame: number | undefined;
  readonly changeEmitter: EventEmitter<TerminalChange>;
  readonly selectionManager: SelectionManager | undefined;
};

/// A selection's two endpoints as the manager keeps them: writing one
/// replaces that endpoint's tracked cell, reading one resolves it first.
export type SelectionEndpoints = { start: SelectionAnchor | null; end: SelectionAnchor | null };

let readWidget: ((term: Terminal) => WidgetInternals) | undefined;
let readSelection: ((manager: SelectionManager) => SelectionEndpoints) | undefined;

export function registerWidgetInternals(read: (term: Terminal) => WidgetInternals): void {
  readWidget = read;
}

export function widgetInternals(term: Terminal): WidgetInternals {
  if (!readWidget) throw new Error('Terminal registered no reader');
  return readWidget(term);
}

export function registerSelectionInternals(read: (manager: SelectionManager) => SelectionEndpoints): void {
  readSelection = read;
}

export function selectionInternals(manager: SelectionManager): SelectionEndpoints {
  if (!readSelection) throw new Error('SelectionManager registered no reader');
  return readSelection(manager);
}
