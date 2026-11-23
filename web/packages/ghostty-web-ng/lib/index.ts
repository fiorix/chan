/**
 * Public API for @chan/ghostty-web-ng
 *
 * A Terminal runs on the core its `ghostty` option hands it, chan's
 * binding of libghostty-vt
 * (`GhosttyVt`, exported as `@chan/ghostty-web-ng/vt`).
 */

// Main Terminal class
export { Terminal } from './terminal';
export { TerminalCoreDisposedError } from './terminal-core';

export type {
  ITheme,
  TerminalChange,
  TerminalCore,
  TerminalCoreSearch,
  TerminalCoreTrackedCell,
  TerminalHighlights,
  TerminalTestHooks,
  TerminalLinkActivation,
  TerminalLinkKind,
  TerminalViewport,
} from './interfaces';

// The key numbering the input handler encodes keys by
export { Key, KeyEncoderOption } from './types';

// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { FontMetrics, PaintFrame, PaintLayer } from './renderer';
export { InputHandler } from './input-handler';
export { SelectionManager } from './selection-manager';

export type { SelectionAnchor, SelectionRange } from './selection-manager';
export type { HighlightRange, HighlightStyle } from './highlights';
