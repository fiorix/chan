/**
 * Terminal - Main terminal emulator class
 *
 * Terminal widget over libghostty-vt with canvas rendering and browser input.
 *
 * Usage:
 * ```typescript
 * import { Terminal } from '@chan/ghostty-web-ng';
 * import { GhosttyVt } from '@chan/ghostty-web-ng/vt';
 *
 * const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
 * const term = new Terminal({ ghostty });
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { VtCells, type GhosttyVt, type VtTerminal, type VtTerminalConfig, type VtTrackedCell } from '../vt/ghosttyVt';
import { BufferNamespace } from './buffer';
import { parseColor } from './color';
import { EventEmitter } from './event-emitter';
import { HighlightsManager } from './highlights';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  IBufferNamespace,
  IEvent,
  ITheme,
  ITerminalOptions,
  TerminalChange,
  TerminalCore,
  TerminalHighlights,
  TerminalSearch,
  TerminalLinkActivation,
  TerminalViewport,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer, type FontMetrics, type PaintLayer } from './renderer';
import { DRAG_THRESHOLD_CELLS, SelectionManager, type SelectionRange } from './selection-manager';
import { createTerminalCore } from './terminal-core';
import { SearchOwner } from './search';
import type { ILink } from './types';

/**
 * Whether a mouse report is motion with no button held: code 35 under the
 * Shift, Meta and Control bits, in the SGR or the X10 form.
 */
function isButtonlessMotionReport(data: string): boolean {
  const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
  const code = sgr ? Number(sgr[1])
    : data.length === 6 && data.startsWith('\x1b[M') ? data.charCodeAt(3) - 32 : NaN;
  return (code & ~0x1c) === 35;
}

/** Report an error as an uncaught one, without unwinding the caller. */
function reportPaintError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else setTimeout(() => { throw error; });
}

// ============================================================================
// Terminal Class
// ============================================================================

export class Terminal {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;
  public readonly viewport: TerminalViewport;

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: GhosttyVt;
  public wasmTerm?: VtTerminal; // Made public for link providers
  #coreAccess?: ReturnType<typeof createTerminalCore>;
  /** Available from open to dispose; the widget retains ownership of the raw core. */
  get core(): TerminalCore | undefined { return this.#coreAccess?.core; }
  public renderer?: CanvasRenderer;
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private highlightsManager?: HighlightsManager;
  #searchOwner?: SearchOwner;
  public readonly search: TerminalSearch;
  /** Stable facade; requests before open or after disposal do not retain state. */
  public readonly highlights: TerminalHighlights = {
    set: (name, ranges, style) => { this.highlightsManager?.set(name, ranges, style); },
    get: (name) => this.highlightsManager?.get(name),
    clear: (name) => this.highlightsManager?.clear(name) ?? false,
  };
  private canvas?: HTMLCanvasElement;

  // Link detection system
  private linkDetector?: LinkDetector;
  // The row under the pointer, read for the link its cell carries.
  private hoverCells = new VtCells();
  private currentHoveredLink?: ILink;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: MouseEvent;
  // The primary press a click ends, read to tell a link click from the end of
  // a drag or a press the program was sent.
  private linkPress?: { x: number; y: number; id: number; type: string; reported: boolean; released: boolean };

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  private changeEmitter = new EventEmitter<TerminalChange>();
  private linkEmitter = new EventEmitter<TerminalLinkActivation>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onChange: IEvent<TerminalChange> = this.changeEmitter.event;
  /**
   * A click on a link: a primary-button click that ends neither a drag nor a
   * double click, and whose press was not reported to a program tracking the
   * mouse (Shift keeps a press from the program). With no listener a click on
   * a link does nothing.
   */
  public readonly onLinkActivate: IEvent<TerminalLinkActivation> = this.linkEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private writeQueue: Uint8Array[] = [];
  private awaitingEcho = false;

  // Phase 1: Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Phase 2: Viewport and scrolling state
  public viewportY: number = 0; // Top line of viewport in scrollback buffer (0 = at bottom, can be fractional during smooth scroll)
  private targetViewportY: number = 0; // Target viewport position for smooth scrolling
  private scrollAnimationStartTime?: number;
  private scrollAnimationFrame?: number;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;

  // Scrollbar interaction state
  private scrollbarDrag?: {
    id: number;
    type: string;
    lastY: number;
    userSelect: string;
    webkitUserSelect: string;
  };

  // Scrollbar visibility/auto-hide state
  private scrollbarVisible: boolean = false;
  private scrollbarOpacity: number = 0;
  private scrollbarHideTimeout?: number;
  private scrollbarAnimationFrame?: number;
  private readonly SCROLLBAR_HIDE_DELAY_MS = 1500; // Hide after 1.5 seconds
  private readonly SCROLLBAR_FADE_DURATION_MS = 200; // 200ms fade animation

  constructor(options: ITerminalOptions) {
    this.ghostty = options.ghostty;

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: { ...options.theme },
      scrollback: options.scrollback ?? 10000,
      scrollbackBytes: options.scrollbackBytes,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      lineHeight: options.lineHeight ?? 1,
      boxGlyphs: options.boxGlyphs ?? false,
      scrollbar: options.scrollbar,
      disableStdin: options.disableStdin ?? false,
      copy: options.copy,
      joinDrawnWraps: options.joinDrawnWraps,
      testHooks: options.testHooks,
      smoothScrollDuration: options.smoothScrollDuration ?? 100, // Default: 100ms smooth scroll
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];
        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
    const terminal = this;
    const emptySearch = Object.freeze({ index: 0, total: 0, partial: false });
    this.search = Object.freeze({
      find: (query: string) => this.#searchOwner?.find(query),
      step: (query: string, direction: 'older' | 'newer') => this.#searchOwner?.step(query, direction),
      close: () => this.#searchOwner?.close(),
      get state() { return terminal.#searchOwner?.state ?? emptySearch; },
      onChange: (listener: Parameters<TerminalSearch['onChange']>[0]) => this.#searchOwner?.onChange(listener) ?? { dispose() {} },
    });
    this.viewport = {
      get offset() { return terminal.viewportY; },
      followOutput: 'at-bottom',
      scrollTo: (offset) => this.scrollViewportTo(offset),
      scrollBy: (rows) => this.scrollViewportTo(this.viewportY + rows),
      scrollToBottom: () => this.scrollToBottom(),
      reveal: (row, align = 'center') => this.revealRow(row, align),
    };
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        if (this.renderer) {
          this.renderer.setCursorStyle(this.options.cursorStyle);
          this.renderer.setCursorBlink(this.options.cursorBlink);
        }
        break;

      case 'theme':
        this.wasmTerm!.setColors(this.buildWasmConfig());
        this.renderer!.setTheme(this.options.theme);
        this.refresh();
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // Resize canvas to match new font metrics
    this.renderer.resize(this.cols, this.rows);

    // Force full re-render with new font
    this.renderer.render(this.wasmTerm, true, this.viewportY, this.paintScrollbarOpacity());
  }

  private parseColorToHex(color?: string): number | undefined {
    const parsed = parseColor(color);
    if (!parsed) return undefined;
    return (Math.round(parsed[0]) << 16) | (Math.round(parsed[1]) << 8) | Math.round(parsed[2]);
  }

  /**
   * Convert terminal options to WASM terminal config.
   */
  private buildWasmConfig(): VtTerminalConfig | undefined {
    const theme = this.options.theme;
    const scrollback = this.options.scrollback;
    // wasm32 SIZE_MAX means unlimited, so keep finite budgets below it.
    const scrollbackMaxBytes = Number.isInteger(this.options.scrollbackBytes) && this.options.scrollbackBytes > 0
      ? Math.min(this.options.scrollbackBytes, 0xffff_fffe) : undefined;

    // If no theme and default scrollback, use defaults
    if (!theme && scrollback === 10000 && scrollbackMaxBytes === undefined) {
      return undefined;
    }

    // Build palette array from theme colors
    // Order: black, red, green, yellow, blue, magenta, cyan, white,
    //        brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite
    const palette = [
      this.parseColorToHex(theme?.black),
      this.parseColorToHex(theme?.red),
      this.parseColorToHex(theme?.green),
      this.parseColorToHex(theme?.yellow),
      this.parseColorToHex(theme?.blue),
      this.parseColorToHex(theme?.magenta),
      this.parseColorToHex(theme?.cyan),
      this.parseColorToHex(theme?.white),
      this.parseColorToHex(theme?.brightBlack),
      this.parseColorToHex(theme?.brightRed),
      this.parseColorToHex(theme?.brightGreen),
      this.parseColorToHex(theme?.brightYellow),
      this.parseColorToHex(theme?.brightBlue),
      this.parseColorToHex(theme?.brightMagenta),
      this.parseColorToHex(theme?.brightCyan),
      this.parseColorToHex(theme?.brightWhite),
    ];

    return {
      scrollbackLimit: scrollback,
      scrollbackMaxBytes,
      fgColor: this.parseColorToHex(theme?.foreground),
      bgColor: this.parseColorToHex(theme?.background),
      cursorColor: this.parseColorToHex(theme?.cursor),
      palette,
    };
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element
    this.element = parent;
    this.isOpen = true;

    try {
      // Make parent focusable if it isn't already
      if (!parent.hasAttribute('tabindex')) {
        parent.setAttribute('tabindex', '0');
      }

      // Mark as contenteditable so browser extensions (Vimium, etc.) recognize
      // this as an input element and don't intercept keyboard events.
      parent.setAttribute('contenteditable', 'true');
      // Prevent actual content editing - we handle input ourselves
      parent.addEventListener('beforeinput', this.handleBeforeInput);

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions and config
      const config = this.buildWasmConfig();
      this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
      this.#coreAccess = createTerminalCore(this.wasmTerm);

      // Create canvas element
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = 'text';

      parent.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0'); // Allow focus for mobile keyboard
      this.textarea.setAttribute('aria-label', 'Terminal input');
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      parent.appendChild(this.textarea);

      // Focus textarea on interaction - preventDefault before focus
      this.canvas.addEventListener('mousedown', this.handleCanvasFocus);
      this.canvas.addEventListener('touchend', this.handleCanvasFocus);

      // Create renderer
      this.renderer = new CanvasRenderer(this.canvas, {
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
        theme: this.options.theme,
        lineHeight: this.options.lineHeight,
        boxGlyphs: this.options.boxGlyphs,
        scrollbar: this.options.scrollbar,
      });

      // Size canvas to terminal dimensions (use renderer.resize for proper DPI scaling)
      this.renderer.resize(this.cols, this.rows);

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const renderer = this.renderer;
      const wasmTerm = this.wasmTerm;
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => wasmTerm?.hasMouseTracking() ?? false,
        hasSgrMouseMode: () => wasmTerm?.getMode(1006, false) ?? true, // SGR extended mode
        getCellDimensions: () => ({
          width: renderer.charWidth,
          height: renderer.charHeight,
        }),
        getGridDimensions: () => ({ cols: this.cols, rows: this.rows }),
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          return { left: rect.left, top: rect.top };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        (data: string, isUserInput = true) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Mouse reports share this callback but leave a reader in history.
          if (isUserInput && data) {
            this.scrollToBottom();
            this.awaitingEcho = true;
          }
          // Reports clear stale selection, but cannot cancel a local drag,
          // and the pointer passing over the grid is not a reason to clear.
          if (isUserInput || !(this.selectionManager?.hasLocalSelectionGesture() || isButtonlessMotionReport(data))) {
            this.selectionManager?.clearSelection();
          }
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        () => {},
        undefined,
        this.customKeyEventHandler,
        (mode: number) => {
          // Query terminal mode state (e.g., mode 1 for application cursor mode)
          return this.wasmTerm?.getMode(mode, false) ?? false;
        },
        () => {
          // Handle Cmd+C copy - returns true if there was a selection to copy
          return this.copySelection();
        },
        this.textarea,
        mouseConfig
      );

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea,
        {
          claimScrollbarPress: (event) => this.claimScrollbarPress(event),
          press: (event, reported) => {
            this.handleLinkPress(event, reported);
            this.inputHandler?.handleMouseDown(event, reported);
          },
          move: (event, reportMotion) => {
            if (this.scrollbarDrag) return;
            this.checkLinkDrag(event);
            this.inputHandler?.handleMouseMove(event, reportMotion);
          },
          release: (event) => this.inputHandler?.handleMouseUp(event),
          end: (event) => {
            this.finishLinkPress(event);
            this.inputHandler?.endMouseGesture(event);
          },
        }
      );

      // Connect selection manager to renderer
      this.renderer.setSelectionManager(this.selectionManager);
      this.highlightsManager = new HighlightsManager(this.wasmTerm.isAlternateScreen());
      this.renderer.setHighlights(this.highlightsManager);
      this.#searchOwner = new SearchOwner(this.#coreAccess.core, this.highlightsManager, this.viewport,
        this.wasmTerm.isAlternateScreen(), () => this.getSelectionRange(), () => this.wasmTerm!.createSearch());

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this);

      // Register link providers
      // OSC8 first (explicit hyperlinks take precedence)
      this.linkDetector.registerProvider(new OSC8LinkProvider(this));
      // URL regex second (fallback for plain text URLs)
      this.linkDetector.registerProvider(new UrlRegexProvider(this));

      // Clear an abandoned click before selection resolves the next press.
      parent.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
      parent.addEventListener('pointermove', this.handlePointerMove);
      parent.addEventListener('pointerup', this.handlePointerEnd);
      parent.addEventListener('pointercancel', this.handlePointerEnd);
      parent.addEventListener('lostpointercapture', this.handlePointerEnd);
      parent.addEventListener('mousemove', this.handleMouseMove);
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      parent.addEventListener('click', this.handleClick);

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this.paintScrollbarOpacity());

      // Start render loop
      this.startRenderLoop();

      // No focus here, as xterm.js's open() takes none: a terminal can open
      // where it is not the one being typed into, and taking the keyboard
      // even for a moment blurs the element that holds it, which can end an
      // edit there. The caller focuses the terminal when it should have it.
    } catch (error) {
      // Clean up on error
      this.isOpen = false;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Write data to terminal
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    this.writeInternal(data, callback);
  }

  /**
   * Internal write implementation (extracted from write())
   */
  private writeInternal(data: string | Uint8Array, callback?: () => void): void {
    if (data.length === 0) {
      if (callback) requestAnimationFrame(callback);
      return;
    }
    const core = this.wasmTerm!;
    const viewportBefore = this.viewportY;
    const targetBefore = this.targetViewportY;
    const scrolling = this.scrollAnimationStartTime !== undefined;
    const scrollbackBefore = this.getScrollbackLength();
    const primary = !core.isAlternateScreen();
    // History length can shrink while new rows arrive because the core
    // prunes whole pages. Track the rows themselves across the write.
    const anchor = primary && viewportBefore >= 1
      ? core.trackCell(scrollbackBefore - Math.floor(viewportBefore), 0) : null;
    let targetAnchor: VtTrackedCell | null = null;
    let scrollbackAfter = scrollbackBefore;
    try {
      targetAnchor = primary && scrolling && targetBefore >= 1
        ? core.trackCell(scrollbackBefore - Math.floor(targetBefore), 0) : null;
      core.write(data);
      scrollbackAfter = this.getScrollbackLength();
      // Sub-row gestures follow the live screen without losing their
      // fraction. A discarded anchor falls back to the oldest retained row.
      const position = anchor?.point();
      const offset = viewportBefore < 1 ? viewportBefore
        : position ? scrollbackAfter - position.row + viewportBefore % 1 : scrollbackAfter;
      this.viewportY = Math.max(0, Math.min(scrollbackAfter, offset));
      if (scrolling) {
        // The visible row can be pruned while a newer gesture target survives.
        const targetPosition = targetAnchor?.point();
        const target = targetBefore < 1 ? targetBefore
          : targetPosition ? scrollbackAfter - targetPosition.row + targetBefore % 1 : scrollbackAfter;
        this.targetViewportY = Math.max(0, Math.min(scrollbackAfter, target));
      } else {
        this.targetViewportY = this.viewportY;
      }
    } finally {
      anchor?.free();
      targetAnchor?.free();
    }

    this.selectionManager?.syncSelection();
    this.highlightsManager?.observeScreen(core.isAlternateScreen());

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // Observers see the current links and view, with replies already sent,
    // before an echo or scrollbar animation can paint synchronously.
    this.#searchOwner?.changed('write', core.isAlternateScreen());
    this.changeEmitter.fire({ kind: 'write' });

    if (viewportBefore > 0 && scrollbackAfter > 0) this.showScrollbar();

    // Call callback if provided
    if (callback) {
      // Queue callback after next render
      requestAnimationFrame(callback);
    }

    if (this.awaitingEcho) {
      this.awaitingEcho = false;
      if (this.renderer && this.wasmTerm) {
        // The core has taken the bytes and the observers have run, so a
        // failed paint is reported rather than thrown at the writer.
        try {
          this.#searchOwner?.runDue();
          this.renderer.render(this.wasmTerm, false, this.viewportY, this.paintScrollbarOpacity());
        } catch (error) {
          reportPaintError(error);
        }
      }
    }

    // Render will happen on next animation frame
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    const bracketed = this.wasmTerm!.hasBracketedPaste();
    if (data || bracketed) this.awaitingEcho = true;

    // Check if terminal has bracketed paste mode enabled
    if (bracketed) {
      this.scrollToBottom();
      // Wrap with bracketed paste sequences (DEC mode 2004)
      this.dataEmitter.fire('\x1b[200~' + data + '\x1b[201~');
    } else {
      // Send data directly
      if (data) this.scrollToBottom();
      this.dataEmitter.fire(data);
    }
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      if (data) {
        this.scrollToBottom();
        this.awaitingEcho = true;
      }
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views)
      this.wasmTerm!.resize(cols, rows);
      this.viewportY = Math.min(this.viewportY, this.getScrollbackLength());
      this.targetViewportY = Math.min(this.targetViewportY, this.getScrollbackLength());
      this.selectionManager?.syncSelection();
      this.highlightsManager?.observeScreen(this.wasmTerm!.isAlternateScreen());

      // Resize renderer
      this.renderer!.resize(cols, rows);

      this.#searchOwner?.changed('resize', this.wasmTerm!.isAlternateScreen());
      this.changeEmitter.fire({ kind: 'resize' });

      // The dimension event also serves PTY size publication.
      this.resizeEmitter.fire({ cols, rows });

      // Force full render
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this.paintScrollbarOpacity());
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    // Flush any writes that were queued during resize, then restart render loop
    this.flushWriteQueue();
    this.startRenderLoop();
  }

  /**
   * Focus terminal input synchronously without scrolling. Calls before open,
   * while detached or after disposal are ignored; no later retry takes focus.
   */
  focus(): void {
    if (this.isOpen && this.element?.isConnected) {
      this.element.focus({ preventScroll: true });
    }
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    if (this.isOpen && this.element) {
      // A press on the canvas can leave the hidden textarea holding focus
      // rather than the element, and blur() acts only on the focused element,
      // so blur whichever of the two holds it. Focus outside stays put.
      const root = this.element.getRootNode() as Document | ShadowRoot;
      const focused = root.activeElement as HTMLElement | null | undefined;
      if (focused && this.element.contains(focused)) {
        focused.blur();
      }
    }
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /** Inclusive absolute-row selection, in either direction; null clears. */
  public setSelection(range: SelectionRange | null): void {
    this.selectionManager?.setSelection(range);
  }

  /** A snapshot of the current selection, or null when unavailable. */
  public getSelectionRange(): SelectionRange | null {
    return this.selectionManager?.getSelectionRange() ?? null;
  }

  /** Client CSS pixels to viewport and absolute cells; null without geometry. */
  public cellAt(clientX: number, clientY: number): { col: number; row: number; absoluteRow: number } | null {
    return this.selectionManager?.cellAt(clientX, clientY) ?? null;
  }

  /**
   * The text a selection of `range` would copy; leaves selection untouched.
   * Throws RangeError for non-integer coordinates while the terminal is open.
   */
  public getRangeText(range: SelectionRange): string {
    return this.selectionManager?.getRangeText(range) ?? '';
  }

  /** Copy-formatted retained history and screen; leaves selection untouched. */
  public getScrollbackText(): string {
    return this.selectionManager?.getScrollbackText() ?? '';
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Read a snapshot of the cursor's zero-based column and row on the active
   * live screen, independent of viewport scrolling. Reflects writes and
   * cursor moves synchronously; undefined before open and after disposal.
   */
  public getCursor(): Readonly<{ x: number; y: number }> | undefined {
    if (!this.isOpen || !this.wasmTerm) return undefined;
    const { x, y } = this.wasmTerm.getCursor();
    return { x, y };
  }

  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  /** Add a layer above the widget; an unopened terminal retains no registration. */
  public addPaintLayer(layer: PaintLayer): () => void {
    if (!this.isOpen) return () => {};
    return this.renderer!.addPaintLayer(layer);
  }

  /**
   * Repaint synchronously at the current scrollbar opacity. During a paint
   * callback, request a full next frame instead of recursively rendering.
   */
  public refresh(): void {
    if (!this.isOpen) return;
    this.renderer!.render(this.wasmTerm!, true, this.viewportY, this.paintScrollbarOpacity());
  }

  /**
   * Replace the theme with a copy and repaint the complete widget synchronously.
   * Before open, only the held theme changes; after disposal, nothing changes.
   * A paint callback requesting a theme change gets a full next frame.
   */
  public setTheme(theme: ITheme): void {
    if (this.isDisposed) return;
    this.options.theme = Object.fromEntries(Object.entries(theme).filter(([, value]) => value !== undefined));
  }

  /** Cell dimensions in CSS pixels, or undefined while the widget is not open. */
  public getMetrics(): Readonly<FontMetrics> | undefined {
    return this.isOpen ? this.renderer!.getMetrics() : undefined;
  }

  private paintScrollbarOpacity(): number {
    const fixed = this.options.testHooks?.scrollbarOpacity;
    return fixed !== undefined ? Math.max(0, Math.min(1, fixed)) : this.scrollbarOpacity;
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler, called for each keydown before
   * the widget encodes it. A key it returns true for is the embedder's: the
   * widget sends nothing for it and leaves its default alone, so the
   * embedder prevents the default wherever it acts on the key.
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  // ==========================================================================
  // Phase 2: Scrolling Methods
  // ==========================================================================

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Calculate new viewport position
    // viewportY = 0 means at bottom (no scroll)
    // viewportY > 0 means scrolled up into history
    // amount < 0 (scroll up) should INCREASE viewportY
    // amount > 0 (scroll down) should DECREASE viewportY
    // So we SUBTRACT amount (negative amount becomes positive change)
    const newViewportY = Math.max(0, Math.min(maxScroll, this.viewportY - amount));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;

      // Show scrollbar when scrolling (with auto-hide)
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    this.targetViewportY = 0;
    if (this.scrollAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }
    this.scrollAnimationStartTime = undefined;
    if (this.viewportY !== 0) {
      this.viewportY = 0;
      // Show scrollbar briefly when scrolling to bottom
      if (this.getScrollbackLength() > 0) {
        this.showScrollbar();
      }
    }
  }

  private scrollViewportTo(offset: number): void {
    const scrollbackLength = this.getScrollbackLength();
    const newViewportY = Math.max(0, Math.min(scrollbackLength, offset));
    this.targetViewportY = newViewportY;
    if (this.scrollAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }
    this.scrollAnimationStartTime = undefined;

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;

      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  private revealRow(row: number, align: 'start' | 'center' | 'end'): void {
    const history = this.getScrollbackLength();
    const onScreen = row - history + Math.max(0, Math.floor(this.viewportY));
    if (onScreen >= 0 && onScreen < this.rows) return;
    const at = align === 'start' ? 0 : align === 'end' ? this.rows - 1 : Math.floor(this.rows / 2);
    this.scrollViewportTo(history - row + at);
  }

  /**
   * Smoothly scroll to a target viewport position
   * @param targetY Target viewport Y position (in lines, can be fractional)
   */
  private smoothScrollTo(targetY: number): void {
    if (!this.wasmTerm) return;

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Clamp target to valid range
    const newTarget = Math.max(0, Math.min(maxScroll, targetY));

    // If smooth scrolling is disabled (duration = 0), jump immediately
    const duration = this.options.smoothScrollDuration ?? 100;
    if (duration === 0) {
      this.viewportY = newTarget;
      this.targetViewportY = newTarget;

      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      return;
    }

    // Update target (accumulate if animation running)
    this.targetViewportY = newTarget;

    // If animation is already running, don't restart it
    // Just let it continue toward the updated target
    // This prevents choppy restarts during continuous scrolling
    if (this.scrollAnimationFrame) {
      return;
    }

    // Start new animation
    this.scrollAnimationStartTime = Date.now();
    this.animateScroll();
  }

  /**
   * Animation loop for smooth scrolling
   * Uses asymptotic approach - moves a fraction of remaining distance each frame
   */
  private animateScroll = (): void => {
    if (!this.wasmTerm || this.scrollAnimationStartTime === undefined) {
      return;
    }

    const duration = this.options.smoothScrollDuration ?? 100;

    // Calculate distance to target
    const distance = this.targetViewportY - this.viewportY;
    const absDistance = Math.abs(distance);

    // If very close, snap to target
    if (absDistance < 0.01) {
      this.viewportY = this.targetViewportY;

      const scrollbackLength = this.getScrollbackLength();
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }

      // Animation complete
      this.scrollAnimationFrame = undefined;
      this.scrollAnimationStartTime = undefined;
      return;
    }

    // Move a fraction of the remaining distance
    // At 60fps, move ~1/6 of distance per frame for ~100ms total duration
    // This creates smooth deceleration toward target
    const framesForDuration = (duration / 1000) * 60; // Convert ms to frame count
    const moveRatio = 1 - (1 / framesForDuration) ** 2; // Ease-out
    this.viewportY += distance * moveRatio;

    // Show scrollbar during animation
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0) {
      this.showScrollbar();
    }

    // Continue animation
    this.scrollAnimationFrame = requestAnimationFrame(this.animateScroll);
  };

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop and clear write queue
    this.cancelRenderLoop();
    this.writeQueue.length = 0;

    // Stop smooth scroll animation
    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }

    // Clear mouse move throttle timeout
    if (this.mouseMoveThrottleTimeout) {
      clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;

    // Clean up components
    this.cleanupComponents();

    // Dispose event emitters
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.changeEmitter.dispose();
    this.linkEmitter.dispose();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Flush any writes that were queued during resize
   */
  private flushWriteQueue(): void {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.shift()!;
      this.wasmTerm!.write(data);
    }
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    if (this.animationFrameId) return; // already running
    // Search work belongs to animation frames, not to the open or resize
    // call that starts the loop with a paint of its own.
    let inFrame = false;
    const loop = () => {
      if (!this.isDisposed && this.isOpen) {
        // Render using the core's own dirty tracking
        // The render() method:
        // 1. Begins a frame on the terminal (beginFrame), which brings its
        //    render state up to date and lists the rows that changed
        // 2. Only redraws dirty rows when forceAll=false
        // 3. Always ends the frame (endFrame) at the end
        try {
          // Search runs first, so this paint shows its results.
          if (inFrame) this.#searchOwner?.runDue();
          inFrame = true;
          this.renderer!.render(this.wasmTerm!, false, this.viewportY, this.paintScrollbarOpacity());
        } finally {
          if (!this.isDisposed && this.isOpen) this.animationFrameId = requestAnimationFrame(loop);
        }
      }
    };
    loop();
  }

  /**
   * Get scrollback length from native WASM
   */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    this.#searchOwner?.dispose();
    this.#searchOwner = undefined;
    this.#coreAccess?.dispose();
    this.#coreAccess = undefined;
    this.endScrollbarDrag();
    this.cancelRenderLoop();
    if (this.scrollbarAnimationFrame !== undefined) cancelAnimationFrame(this.scrollbarAnimationFrame);
    this.scrollbarAnimationFrame = undefined;
    this.linkPress = undefined;
    this.currentHoveredLink = undefined;
    this.hoverCells = new VtCells();

    this.highlightsManager?.dispose();
    this.highlightsManager = undefined;

    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    if (this.canvas) {
      this.canvas.removeEventListener('mousedown', this.handleCanvasFocus);
      this.canvas.removeEventListener('touchend', this.handleCanvasFocus);
      this.canvas.remove();
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea && this.textarea.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
      this.textarea = undefined;
    }

    // Remove event listeners
    if (this.element) {
      this.element.removeEventListener('beforeinput', this.handleBeforeInput);
      this.element.removeEventListener('wheel', this.handleWheel, { capture: true });
      this.element.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
      this.element.removeEventListener('pointermove', this.handlePointerMove);
      this.element.removeEventListener('pointerup', this.handlePointerEnd);
      this.element.removeEventListener('pointercancel', this.handlePointerEnd);
      this.element.removeEventListener('lostpointercapture', this.handlePointerEnd);
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('click', this.handleClick);

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
    }

    // Clean up scrollbar timers
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Clear references
    this.ghostty = undefined;
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Throttle link hover detection while leaving captured moves synchronous.
   */
  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    if (this.scrollbarDrag) return;

    if (!this.linkDetector) return;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout) {
      this.pendingMouseMove = e;
      return;
    }

    this.processMouseMove(e);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Convert mouse coordinates to terminal cell position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);

    // Get the link the cell at this position carries
    // Must account for viewportY (scrollback position)
    const viewportRow = y; // Row in the viewport (0 to rows-1)
    let hyperlinkId = 0;

    // When scrolled, fetch from scrollback or screen based on position
    // NOTE: viewportY may be fractional during smooth scrolling. The renderer
    // uses Math.floor(viewportY) when mapping viewport rows to scrollback vs
    // screen; we mirror that logic here so link hit-testing matches what the
    // user sees on screen.
    let read = false;
    const rawViewportY = this.getViewportY();
    const viewportY = Math.max(0, Math.floor(rawViewportY));
    if (viewportY > 0) {
      const scrollbackLength = this.wasmTerm.getScrollbackLength();
      if (viewportRow < viewportY) {
        // Mouse is over scrollback content
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        read = this.wasmTerm.readHistoryRow(scrollbackOffset, this.hoverCells);
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportY;
        read = this.wasmTerm.readRow(screenRow, this.hoverCells);
      }
    } else {
      // At bottom - just use screen buffer
      read = this.wasmTerm.readRow(viewportRow, this.hoverCells);
    }

    const cell = read ? this.hoverCells.at(x) : undefined;
    if (cell) {
      hyperlinkId = cell.hyperlink;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    // Check if there's a link at this position (for click handling and cursor)
    // Buffer API expects absolute buffer coordinates (including scrollback)
    // When scrolled, we need to adjust the buffer row based on viewportY
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForBuffer = this.getViewportY();
    const viewportYForBuffer = Math.max(0, Math.floor(rawViewportYForBuffer));

    if (viewportYForBuffer > 0) {
      // When scrolled, the buffer row depends on where in the viewport we are
      if (viewportRow < viewportYForBuffer) {
        // Mouse is over scrollback content
        bufferRow = scrollbackLength - viewportYForBuffer + viewportRow;
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportYForBuffer;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      // At bottom - buffer row is scrollback + screen row
      bufferRow = scrollbackLength + viewportRow;
    }

    // Make async call non-blocking - don't await
    this.linkDetector
      .getLinkAt(x, bufferRow)
      .then((link) => {
        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Update current link
          this.currentHoveredLink = link;

          // Update cursor style on both container and canvas
          const cursorStyle = link ? 'pointer' : 'text';
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              // Convert buffer coordinates to viewport coordinates
              const scrollbackLength = this.wasmTerm?.getScrollbackLength() || 0;

              // Calculate viewport Y for start and end positions
              // Use floored viewportY so overlay rows match renderer & selection
              const rawViewportYForLinks = this.getViewportY();
              const viewportYForLinks = Math.max(0, Math.floor(rawViewportYForLinks));
              const startViewportY = link.range.start.y - scrollbackLength + viewportYForLinks;
              const endViewportY = link.range.end.y - scrollbackLength + viewportYForLinks;

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    // Clear hyperlink underline
    if (this.renderer && this.wasmTerm) {
      const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
      if (previousHyperlinkId > 0) {
        this.renderer.setHoveredHyperlinkId(0);

        // The 60fps render loop will pick up the change automatically
      }
      // Clear regex link underline
      this.renderer.setHoveredLinkRange(null);
    }

    if (this.currentHoveredLink) {
      // Clear hovered link
      this.currentHoveredLink = undefined;

      // Reset cursor
      if (this.element) {
        this.element.style.cursor = 'text';
        if (this.canvas) {
          this.canvas.style.cursor = 'text';
        }
      }
    }
  };

  private handleBeforeInput = (event: Event): void => {
    if (event.target === this.element) event.preventDefault();
  };

  private handleCanvasFocus = (event: Event): void => {
    event.preventDefault();
    this.textarea?.focus({ preventScroll: true });
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
    const press = this.linkPress;
    if (press && (press.released || (press.id === event.pointerId && press.type === event.pointerType))) {
      this.linkPress = undefined;
    }
  };

  private checkLinkDrag(event: MouseEvent): void {
    const press = this.linkPress;
    if (!press || !this.renderer) return;
    const threshold = this.renderer.charWidth * DRAG_THRESHOLD_CELLS;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy >= threshold * threshold) this.linkPress = undefined;
  }

  private finishLinkPress(event?: MouseEvent): void {
    if (event?.type !== 'pointerup' || !this.canvas?.isConnected) {
      this.linkPress = undefined;
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right ||
        event.clientY < rect.top || event.clientY >= rect.bottom) {
      this.linkPress = undefined;
      return;
    }
    this.checkLinkDrag(event);
    if (this.linkPress) this.linkPress.released = true;
  }

  // Record disposition before synchronous input listeners can change tracking.
  private handleLinkPress = (e: PointerEvent, reported: boolean): void => {
    this.linkPress =
      e.button === 0
        ? {
            x: e.clientX,
            y: e.clientY,
            id: e.pointerId,
            type: e.pointerType,
            released: false,
            reported,
          }
        : undefined;
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = async (e: MouseEvent): Promise<void> => {
    // For more reliable clicking, detect the link at click time
    // rather than relying on cached hover state (avoids async races)
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    const press = this.linkPress;
    this.linkPress = undefined;
    // The second click of a double click selects a word, and a click whose
    // press went to the program is the program's.
    if (e.button !== 0 || e.detail > 1 || !press?.released || press.reported) return;

    // Get click position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    const y = Math.floor((e.clientY - rect.top) / this.renderer.charHeight);

    // Calculate buffer row (same logic as processMouseMove)
    const viewportRow = y;
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForClick = this.getViewportY();
    const viewportYForClick = Math.max(0, Math.floor(rawViewportYForClick));

    if (viewportYForClick > 0) {
      if (viewportRow < viewportYForClick) {
        bufferRow = scrollbackLength - viewportYForClick + viewportRow;
      } else {
        const screenRow = viewportRow - viewportYForClick;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      bufferRow = scrollbackLength + viewportRow;
    }

    const link = await this.linkDetector.getLinkAt(x, bufferRow);
    if (!link || this.isDisposed) return;
    const { start, end } = link.range;
    this.linkEmitter.fire({
      target: link.target,
      kind: link.kind,
      range: { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } },
      event: e,
    });
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    // Always prevent default browser scrolling
    e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application
      // Applications like vim handle scrolling internally
      // Standard: ~3 arrow presses per wheel "click"
      const direction = e.deltaY > 0 ? 'down' : 'up';
      const count = Math.min(Math.abs(Math.round(e.deltaY / 33)), 5); // Cap at 5

      for (let i = 0; i < count; i++) {
        if (direction === 'up') {
          this.dataEmitter.fire('\x1B[A'); // Up arrow
        } else {
          this.dataEmitter.fire('\x1B[B'); // Down arrow
        }
      }
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.viewportY - deltaLines;
        this.smoothScrollTo(targetY);
      }
    }
  };

  private scrollbarGeometry() {
    const canvas = this.canvas;
    const history = this.getScrollbackLength();
    if (!canvas || history === 0) return;
    const rect = canvas.getBoundingClientRect();
    const track = Math.max(0, rect.height - 8);
    const thumb = Math.min(track, Math.max(20, this.rows / (history + this.rows) * track));
    const travel = track - thumb;
    return { rect, track, thumb, travel, history, top: 4 + travel * (1 - this.viewportY / history) };
  }

  private matchesScrollbarPointer(event: PointerEvent): boolean {
    const drag = this.scrollbarDrag;
    return !!drag && event.isPrimary && event.pointerId === drag.id && event.pointerType === drag.type;
  }

  private claimScrollbarPress(event: PointerEvent): boolean {
    if (this.scrollbarDrag) {
      const captured = this.canvas?.isConnected && this.canvas.hasPointerCapture(this.scrollbarDrag.id);
      if (captured && !this.matchesScrollbarPointer(event)) return true;
      this.endScrollbarDrag();
    }
    if (event.button !== 0 || !event.isPrimary ||
        (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
        this.paintScrollbarOpacity() <= 0 || !this.canvas?.isConnected) return false;
    const geometry = this.scrollbarGeometry();
    if (!geometry) return false;
    const { rect, track, thumb, history, top } = geometry;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < rect.width - 12 || x > rect.width - 4 || y < 0 || y >= rect.height) return false;

    // Selection sees the claim, while the page still receives menu-closing presses.
    event.preventDefault();
    if (y >= top && y <= top + thumb) {
      const canvas = this.canvas;
      try {
        canvas.setPointerCapture(event.pointerId);
        if (!canvas.hasPointerCapture(event.pointerId)) return true;
      } catch {
        return true;
      }
      this.scrollbarDrag = {
        id: event.pointerId, type: event.pointerType, lastY: event.clientY,
        userSelect: canvas.style.userSelect, webkitUserSelect: canvas.style.webkitUserSelect,
      };
      canvas.style.userSelect = 'none';
      canvas.style.webkitUserSelect = 'none';
      // Cancel smooth motion before it can change the position under the held thumb.
      this.viewport.scrollTo(this.viewportY);
      this.showScrollbar();
    } else if (track > 0) {
      this.viewport.scrollTo(Math.round((1 - (y - 4) / track) * history));
    }
    return true;
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.matchesScrollbarPointer(event)) return;
    const drag = this.scrollbarDrag!;
    if (event.buttons === 0 || !this.canvas?.isConnected || !this.canvas.hasPointerCapture(drag.id)) {
      this.endScrollbarDrag();
      return;
    }
    const geometry = this.scrollbarGeometry();
    const delta = event.clientY - drag.lastY;
    // Every move rebases at the actual clamped viewport. Writes can re-anchor
    // that viewport between moves, so neither output nor overshoot is replayed.
    drag.lastY = event.clientY;
    if (!geometry || geometry.travel <= 0) return;
    this.viewport.scrollTo(this.viewportY - delta * geometry.history / geometry.travel);
  };

  private handlePointerEnd = (event: PointerEvent): void => {
    if (this.matchesScrollbarPointer(event)) this.endScrollbarDrag();
  };

  private endScrollbarDrag(): void {
    const drag = this.scrollbarDrag;
    if (!drag) return;
    this.scrollbarDrag = undefined;
    const canvas = this.canvas;
    if (canvas) {
      canvas.style.userSelect = drag.userSelect;
      canvas.style.webkitUserSelect = drag.webkitUserSelect;
      try {
        if (canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
      } catch {
        // Removing a host can already have released its capture.
      }
    }
    if (this.isOpen && this.getScrollbackLength() > 0) this.showScrollbar();
  }

  /**
   * Show scrollbar with fade-in and schedule auto-hide
   */
  private showScrollbar(): void {
    if (this.options.testHooks?.scrollbarOpacity !== undefined) return;
    // Clear any existing hide timeout
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    if (this.scrollbarAnimationFrame !== undefined) {
      cancelAnimationFrame(this.scrollbarAnimationFrame);
      this.scrollbarAnimationFrame = undefined;
    }

    // If not visible, start fade-in
    if (!this.scrollbarVisible) {
      this.scrollbarVisible = true;
      this.scrollbarOpacity = 0;
      this.fadeInScrollbar();
    } else {
      // Already visible, just ensure it's fully opaque
      this.scrollbarOpacity = 1;
    }

    // Schedule auto-hide (unless dragging)
    if (!this.scrollbarDrag) {
      this.scrollbarHideTimeout = window.setTimeout(() => {
        this.hideScrollbar();
      }, this.SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /**
   * Hide scrollbar with fade-out
   */
  private hideScrollbar(): void {
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    if (this.scrollbarVisible) {
      this.fadeOutScrollbar();
    }
  }

  /**
   * Fade in scrollbar
   */
  private fadeInScrollbar(): void {
    const startTime = Date.now();
    const animate = () => {
      this.scrollbarAnimationFrame = undefined;
      if (!this.isOpen) return;
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = progress;

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this.paintScrollbarOpacity());
      }

      if (progress < 1) {
        this.scrollbarAnimationFrame = requestAnimationFrame(animate);
      }
    };
    animate();
  }

  /**
   * Fade out scrollbar
   */
  private fadeOutScrollbar(): void {
    const startTime = Date.now();
    const startOpacity = this.scrollbarOpacity;
    const animate = () => {
      this.scrollbarAnimationFrame = undefined;
      if (!this.isOpen) return;
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = startOpacity * (1 - progress);

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this.paintScrollbarOpacity());
      }

      if (progress < 1) {
        this.scrollbarAnimationFrame = requestAnimationFrame(animate);
      } else {
        this.scrollbarVisible = false;
        this.scrollbarOpacity = 0;
        // Final render to clear scrollbar completely
        if (this.renderer && this.wasmTerm) {
          this.renderer.render(this.wasmTerm, false, this.viewportY, this.paintScrollbarOpacity());
        }
      }
    };
    animate();
  }

  /**
   * Process any pending terminal responses and emit them via onData.
   *
   * This handles escape sequences that require the terminal to send a response
   * back to the PTY, such as:
   * - DSR 6 (cursor position): Shell sends \x1b[6n, terminal responds with \x1b[row;colR
   * - DSR 5 (operating status): Shell sends \x1b[5n, terminal responds with \x1b[0n
   *
   * Without this, shells like nushell that rely on cursor position queries
   * will hang waiting for a response that never comes.
   *
   * Note: We loop to read all pending responses, not just one. This is important
   * when multiple queries are processed in a single write() call (e.g., when
   * buffered data is written all at once during terminal initialization).
   */
  private processTerminalResponses(): void {
    if (!this.wasmTerm) return;

    // Read all pending responses from the WASM terminal
    // Multiple responses can be queued if a single write() contained multiple queries
    while (true) {
      const response = this.wasmTerm.readResponse();
      if (response === null) break;
      // Send response back to the PTY via onData
      // This is the same path as user keyboard input
      this.dataEmitter.fire(response);
    }
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
