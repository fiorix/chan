/**
 * Public API for @cmux/ghostty-terminal
 *
 * Main entry point following xterm.js conventions. A Terminal runs on the
 * core its `ghostty` option hands it, chan's binding of libghostty-vt
 * (`GhosttyVt`, exported as `@chan/ghostty-web-ng/vt`).
 */

// Main Terminal class
export { Terminal } from './terminal';

// xterm.js-compatible interfaces
export type {
  ITerminalOptions,
  ITheme,
  ITerminalAddon,
  ITerminalCore,
  IDisposable,
  IEvent,
  IBufferRange,
  IKeyEvent,
  IUnicodeVersionProvider,
} from './interfaces';

// The key numbering the input handler encodes keys by
export { Key, KeyAction, KeyEncoderOption, Mods } from './types';

// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { RendererOptions, FontMetrics } from './renderer';
export { InputHandler } from './input-handler';
export { EventEmitter } from './event-emitter';
export { SelectionManager } from './selection-manager';
export type { SelectionCoordinates } from './selection-manager';

// Addons
export { FitAddon } from './addons/fit';
export type { ITerminalDimensions } from './addons/fit';

// Link providers
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export { LinkDetector } from './link-detector';
export type { ILink, ILinkProvider, IBufferCellPosition } from './types';
