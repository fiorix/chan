/**
 * Unit tests for InputHandler
 */

import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { InputHandler } from './input-handler';

// Mock DOM types for testing
interface MockKeyboardEvent {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface MockClipboardEvent {
  type: string;
  clipboardData: {
    getData: (format: string) => string;
    setData: (format: string, data: string) => void;
  } | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}
interface MockInputEvent {
  type: string;
  inputType: string;
  data: string | null;
  isComposing?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface MockHTMLElement {
  addEventListener: (event: string, handler: (e: any) => void) => void;
  removeEventListener: (event: string, handler: (e: any) => void) => void;
  childNodes: Node[];
  removeChild: (node: Node) => Node;
  appendChild: (node: Node) => Node;
}

// Helper to create mock keyboard event
function createKeyEvent(
  code: string,
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): MockKeyboardEvent {
  return {
    code,
    key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

// Helper to create mock clipboard event
function createClipboardEvent(text: string | null): MockClipboardEvent {
  const data = new Map<string, string>();
  if (text !== null) {
    data.set('text/plain', text);
  }

  return {
    type: 'paste',
    clipboardData:
      text !== null
        ? {
            getData: (format: string) => data.get(format) || '',
            setData: (format: string, value: string) => {
              data.set(format, value);
            },
          }
        : null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

// Helper to create mock beforeinput event
function createBeforeInputEvent(inputType: string, data: string | null): MockInputEvent {
  return {
    type: 'beforeinput',
    inputType,
    data,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
interface MockCompositionEvent {
  type: string;
  data: string | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

// Helper to create mock composition event
function createCompositionEvent(
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string | null
): MockCompositionEvent {
  return {
    type,
    data,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
// Helper to create mock container
function createMockContainer(): MockHTMLElement & {
  _listeners: Map<string, ((e: any) => void)[]>;
  dispatchEvent: (event: any) => void;
} {
  const listeners = new Map<string, ((e: any) => void)[]>();

  return {
    _listeners: listeners,
    addEventListener(event: string, handler: (e: any) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(handler);
    },
    removeEventListener(event: string, handler: (e: any) => void) {
      const handlers = listeners.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      }
    },
    dispatchEvent(event: any) {
      const handlers = listeners.get(event.type) || [];
      for (const handler of handlers) {
        handler(event);
      }
    },
    // Mock childNodes and removeChild for text node cleanup test
    childNodes: [] as Node[],
    removeChild(node: Node) {
      const index = this.childNodes.indexOf(node);
      if (index >= 0) {
        this.childNodes.splice(index, 1);
      }
      return node;
    },
    appendChild(node: Node) {
      this.childNodes.push(node);
      return node;
    },
  };
}

// Helper to simulate key event
function simulateKey(
  container: ReturnType<typeof createMockContainer>,
  event: MockKeyboardEvent
): void {
  const handlers = container._listeners.get('keydown') || [];
  for (const handler of handlers) {
    handler(event);
  }
}

describe('InputHandler', () => {
  let vendored: WebAssembly.Module;
  let ghostty: GhosttyVt;
  let container: ReturnType<typeof createMockContainer>;
  let dataReceived: string[];

  beforeAll(async () => {
    vendored = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
  });

  beforeEach(async () => {
    // Each handler gets isolated encoder state over the vendored core.
    ghostty = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));

    // Create mock container for each test
    container = createMockContainer();

    // Reset data tracking
    dataReceived = [];
  });

  describe('Constructor and Lifecycle', () => {
    test('creates handler and attaches listeners', () => {
      const handler = new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      expect(handler.isActive()).toBe(true);
      expect(container._listeners.has('keydown')).toBe(true);
      expect(container._listeners.get('keydown')!.length).toBe(1);
    });

    test('dispose removes listeners and marks inactive', () => {
      const handler = new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      handler.dispose();

      expect(handler.isActive()).toBe(false);
      expect(container._listeners.get('keydown')!.length).toBe(0);
    });

    test('dispose is idempotent', () => {
      const handler = new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      handler.dispose();
      handler.dispose(); // Second call should not throw

      expect(handler.isActive()).toBe(false);
    });
  });

  describe('Printable Characters', () => {
    test('encodes lowercase letters', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyA', 'a'));
      expect(dataReceived).toEqual(['a']);

      simulateKey(container, createKeyEvent('KeyZ', 'z'));
      expect(dataReceived).toEqual(['a', 'z']);
    });

    test('encodes uppercase letters (with shift)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyA', 'A', { shift: true }));
      expect(dataReceived).toEqual(['A']);
    });

    test('encodes digits', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Digit0', '0'));
      simulateKey(container, createKeyEvent('Digit5', '5'));
      simulateKey(container, createKeyEvent('Digit9', '9'));

      expect(dataReceived).toEqual(['0', '5', '9']);
    });

    test('encodes punctuation', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Comma', ','));
      simulateKey(container, createKeyEvent('Period', '.'));
      simulateKey(container, createKeyEvent('Slash', '/'));

      expect(dataReceived).toEqual([',', '.', '/']);
    });

    test('encodes space', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Space', ' '));
      expect(dataReceived).toEqual([' ']);
    });
  });

  describe('IME Composition', () => {
    test('handles composition sequence', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Start composition
      const startEvent = createCompositionEvent('compositionstart', '');
      container.dispatchEvent(startEvent);

      // Update composition (typing)
      const updateEvent1 = createCompositionEvent('compositionupdate', 'n');
      container.dispatchEvent(updateEvent1);

      // Keydown events during composition should be ignored
      const keyEvent1 = createKeyEvent('KeyN', 'n');
      Object.defineProperty(keyEvent1, 'isComposing', { value: true });
      simulateKey(container, keyEvent1);

      // Update composition (more typing)
      const updateEvent2 = createCompositionEvent('compositionupdate', 'ni');
      container.dispatchEvent(updateEvent2);

      // End composition (commit)
      const endEvent = createCompositionEvent('compositionend', '你好');
      container.dispatchEvent(endEvent);

      // Should only receive the final committed text
      expect(dataReceived).toEqual(['你好']);
    });

    test('ignores keydown during composition', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Start composition
      container.dispatchEvent(createCompositionEvent('compositionstart', ''));

      // Simulate keydown with isComposing=true
      const keyEvent = createKeyEvent('KeyA', 'a');
      Object.defineProperty(keyEvent, 'isComposing', { value: true });
      simulateKey(container, keyEvent);

      // Simulate keydown with keyCode 229
      const keyEvent229 = createKeyEvent('KeyB', 'b');
      Object.defineProperty(keyEvent229, 'keyCode', { value: 229 });
      simulateKey(container, keyEvent229);

      // Should not receive any data
      expect(dataReceived.length).toBe(0);

      // End composition
      container.dispatchEvent(createCompositionEvent('compositionend', 'a'));
      expect(dataReceived).toEqual(['a']);
    });

    test('cleans up text nodes in container after composition', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Simulate browser inserting text node during composition
      const textNode = { nodeType: 3, textContent: '你好' } as Node;
      container.appendChild(textNode);

      // Also add a non-text node (e.g. canvas) to ensure it's not removed
      const elementNode = { nodeType: 1, nodeName: 'CANVAS' } as Node;
      container.appendChild(elementNode);

      expect(container.childNodes.length).toBe(2);

      // End composition
      const endEvent = createCompositionEvent('compositionend', '你好');
      container.dispatchEvent(endEvent);

      // Should have removed the text node but kept the element node
      expect(container.childNodes.length).toBe(1);
      expect(container.childNodes[0]).toBe(elementNode);
      expect(dataReceived).toEqual(['你好']);
    });

    test('avoids duplicate commit when compositionend fires before beforeinput', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      container.dispatchEvent(createCompositionEvent('compositionend', '你好'));
      inputElement.dispatchEvent(createBeforeInputEvent('insertText', '你好'));

      expect(dataReceived).toEqual(['你好']);
    });

    test('avoids duplicate commit when beforeinput fires before compositionend', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      inputElement.dispatchEvent(createBeforeInputEvent('insertText', '你好'));
      container.dispatchEvent(createCompositionEvent('compositionend', '你好'));

      expect(dataReceived).toEqual(['你好']);
    });
  });

  describe('Control Characters', () => {
    test('encodes Ctrl+A', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyA', 'a', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+A should produce 0x01
      expect(dataReceived[0].charCodeAt(0)).toBe(0x01);
    });

    test('encodes Ctrl+C', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyC', 'c', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+C should produce 0x03
      expect(dataReceived[0].charCodeAt(0)).toBe(0x03);
    });

    test('encodes Ctrl+D', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyD', 'd', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+D should produce 0x04
      expect(dataReceived[0].charCodeAt(0)).toBe(0x04);
    });

    test('encodes Ctrl+Z', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyZ', 'z', { ctrl: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+Z should produce 0x1A (26)
      expect(dataReceived[0].charCodeAt(0)).toBe(0x1a);
    });

    test('Cmd+C allows copy (no data sent)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyC', 'c', { meta: true }));

      // Cmd+C should NOT send data - it should allow copy operation
      // SelectionManager handles the actual copying
      expect(dataReceived.length).toBe(0);
    });
  });

  describe('Special Keys', () => {
    test('encodes Enter', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Enter', 'Enter'));

      expect(dataReceived.length).toBe(1);
      // Enter should produce \r (0x0D)
      expect(dataReceived[0]).toBe('\r');
    });

    test('encodes Tab', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Tab', 'Tab'));

      expect(dataReceived.length).toBe(1);
      // Tab should produce \t (0x09)
      expect(dataReceived[0]).toBe('\t');
    });

    test('encodes Escape', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Escape', 'Escape'));

      expect(dataReceived.length).toBe(1);
      // Escape should produce ESC (0x1B)
      expect(dataReceived[0].charCodeAt(0)).toBe(0x1b);
    });

    test('encodes Backspace', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Backspace', 'Backspace'));

      expect(dataReceived.length).toBe(1);
      // The handler sends DEL (0x7F) for Backspace (simple-output table).
      expect(dataReceived[0]).toBe('\x7F');
    });
  });

  describe('Arrow Keys', () => {
    test('encodes Up arrow', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));

      expect(dataReceived.length).toBe(1);
      // No cursor-mode callback, so the encoder default is CSI (normal mode): ESC[A.
      expect(dataReceived[0]).toBe('\x1b[A');
    });

    test('encodes Down arrow', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));

      expect(dataReceived.length).toBe(1);
      // Encoder default is CSI (normal mode): ESC[B.
      expect(dataReceived[0]).toBe('\x1b[B');
    });

    test('encodes Left arrow', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));

      expect(dataReceived.length).toBe(1);
      // Encoder default is CSI (normal mode): ESC[D.
      expect(dataReceived[0]).toBe('\x1b[D');
    });

    test('encodes Right arrow', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(1);
      // Encoder default is CSI (normal mode): ESC[C.
      expect(dataReceived[0]).toBe('\x1b[C');
    });

    test('sends CSI sequences in normal cursor mode (mode 1 off)', () => {
      // Create handler with getMode callback that returns false (normal mode)
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (_mode: number) => false // Normal cursor mode
      );

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));
      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));
      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));
      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(4);
      // Normal mode: CSI sequences (ESC[A, ESC[B, ESC[D, ESC[C)
      expect(dataReceived[0]).toBe('\x1b[A');
      expect(dataReceived[1]).toBe('\x1b[B');
      expect(dataReceived[2]).toBe('\x1b[D');
      expect(dataReceived[3]).toBe('\x1b[C');
    });

    test('sends SS3 sequences in application cursor mode (mode 1 on)', () => {
      // Create handler with getMode callback that returns true for mode 1
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (mode: number) => mode === 1 // Application cursor mode enabled
      );

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp'));
      simulateKey(container, createKeyEvent('ArrowDown', 'ArrowDown'));
      simulateKey(container, createKeyEvent('ArrowLeft', 'ArrowLeft'));
      simulateKey(container, createKeyEvent('ArrowRight', 'ArrowRight'));

      expect(dataReceived.length).toBe(4);
      // Application mode: SS3 sequences (ESCOA, ESCOB, ESCOD, ESCOC)
      expect(dataReceived[0]).toBe('\x1bOA');
      expect(dataReceived[1]).toBe('\x1bOB');
      expect(dataReceived[2]).toBe('\x1bOD');
      expect(dataReceived[3]).toBe('\x1bOC');
    });
  });

  describe('Function Keys', () => {
    test('encodes F1', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('F1', 'F1'));

      expect(dataReceived.length).toBe(1);
      // The handler sends SS3 P for F1 (simple-output table), not the rxvt / old-xterm ESC[11~ form.
      expect(dataReceived[0]).toBe('\x1bOP');
    });

    test('encodes F12', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('F12', 'F12'));

      expect(dataReceived.length).toBe(1);
      // The handler sends CSI 24~ for F12 (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[24~');
    });
  });

  describe('Navigation Keys', () => {
    test('encodes Home', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Home', 'Home'));

      expect(dataReceived.length).toBe(1);
      // The handler sends ESC[H for Home in normal cursor mode (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[H');
    });

    test('encodes End', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('End', 'End'));

      expect(dataReceived.length).toBe(1);
      // The handler sends ESC[F for End in normal cursor mode (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[F');
    });

    test('encodes PageUp', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('PageUp', 'PageUp'));

      expect(dataReceived.length).toBe(1);
      // The handler sends CSI 5~ for PageUp (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[5~');
    });

    test('encodes PageDown', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('PageDown', 'PageDown'));

      expect(dataReceived.length).toBe(1);
      // The handler sends CSI 6~ for PageDown (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[6~');
    });

    test('encodes Delete', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Delete', 'Delete'));

      expect(dataReceived.length).toBe(1);
      // The handler sends CSI 3~ for Delete (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[3~');
    });

    test('encodes Insert', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Insert', 'Insert'));

      expect(dataReceived.length).toBe(1);
      // The handler sends CSI 2~ for Insert (simple-output table).
      expect(dataReceived[0]).toBe('\x1b[2~');
    });
  });

  describe('Event Prevention', () => {
    test('prevents default on printable characters', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const event = createKeyEvent('KeyA', 'a');
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('prevents default on special keys', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const event = createKeyEvent('Enter', 'Enter');
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('prevents default on Ctrl+keys', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const event = createKeyEvent('KeyC', 'c', { ctrl: true });
      simulateKey(container, event);

      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('Unknown Keys', () => {
    test('ignores unmapped keys', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Simulate a key that's not in KEY_MAP
      simulateKey(container, createKeyEvent('Unknown', 'Unknown'));

      // Should not crash or produce output
      expect(dataReceived.length).toBe(0);
    });
  });

  describe('Modifier Combinations', () => {
    test('handles Ctrl+Shift combinations', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('KeyA', 'A', { ctrl: true, shift: true }));

      expect(dataReceived.length).toBe(1);
      // Ctrl+Shift+A encodes to 0x01, as Ctrl+A does: SHIFT changes nothing here (core encoder).
      expect(dataReceived[0]).toBe('\x01');
    });

    test('encodes Alt+Up with the Alt modifier', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (_mode: number) => false // Normal cursor mode
      );

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp', { alt: true }));

      expect(dataReceived.length).toBe(1);
      // Alt+Up encodes with the Alt modifier: CSI 1;3 A in normal cursor mode (core encoder).
      expect(dataReceived[0]).toBe('\x1b[1;3A');
    });
  });

  describe('Composition Guard Arms', () => {
    test('ignores a plain keydown while the handler is composing (state arm)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      container.dispatchEvent(createCompositionEvent('compositionstart', ''));

      // No isComposing flag and no 229 keyCode: only the handler's own state guards this.
      simulateKey(container, createKeyEvent('KeyA', 'a'));
      expect(dataReceived.length).toBe(0);

      container.dispatchEvent(createCompositionEvent('compositionend', 'a'));
      expect(dataReceived).toEqual(['a']);
    });

    test('ignores a keydown flagged isComposing with no composition started (event arm)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // No compositionstart: only the event's own flag guards this.
      const keyEvent = createKeyEvent('KeyA', 'a');
      Object.defineProperty(keyEvent, 'isComposing', { value: true });
      simulateKey(container, keyEvent);

      expect(dataReceived.length).toBe(0);
    });

    test('ignores a keydown with keyCode 229 with no composition started (229 arm)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // No compositionstart: only the 229 keyCode guards this.
      const keyEvent = createKeyEvent('KeyA', 'a');
      Object.defineProperty(keyEvent, 'keyCode', { value: 229 });
      simulateKey(container, keyEvent);

      expect(dataReceived.length).toBe(0);
    });
  });

  describe('Modifier Pins', () => {
    test('sends Shift+Up as CSI 1;2 A in normal cursor mode', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (_mode: number) => false // Normal cursor mode
      );

      simulateKey(container, createKeyEvent('ArrowUp', 'ArrowUp', { shift: true }));

      // Dropping SHIFT from the modifier mask would send plain ESC[A instead.
      expect(dataReceived).toEqual(['\x1b[1;2A']);
    });

    test('sends Alt+Enter as ESC CR', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Enter', 'Enter', { alt: true }));

      // Dropping ALT from the modifier mask would send plain CR instead.
      expect(dataReceived).toEqual(['\x1b\r']);
    });

    test('sends Shift+Tab as backtab', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      simulateKey(container, createKeyEvent('Tab', 'Tab', { shift: true }));

      expect(dataReceived).toEqual(['\x1b[Z']);
    });

    test('types Ctrl+Alt+letter as its character (AltGr)', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Ctrl+Alt together (AltGr on some layouts) produce printable characters.
      simulateKey(container, createKeyEvent('KeyA', 'a', { ctrl: true, alt: true }));

      expect(dataReceived).toEqual(['a']);
    });
  });

  describe('BeforeInput Kinds', () => {
    test('maps a newline in insertText to CR', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      inputElement.dispatchEvent(createBeforeInputEvent('insertText', 'a\nb'));

      expect(dataReceived).toEqual(['a\rb']);
    });

    test('maps insertLineBreak to CR', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      inputElement.dispatchEvent(createBeforeInputEvent('insertLineBreak', null));

      expect(dataReceived).toEqual(['\r']);
    });

    test('maps deleteContentBackward to DEL', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      inputElement.dispatchEvent(createBeforeInputEvent('deleteContentBackward', null));

      expect(dataReceived).toEqual(['\x7F']);
    });

    test('maps deleteContentForward to CSI 3~', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      inputElement.dispatchEvent(createBeforeInputEvent('deleteContentForward', null));

      expect(dataReceived).toEqual(['\x1b[3~']);
    });
  });

  describe('Mouse Reporting', () => {
    let handler: InputHandler;
    function createMouseHandler(...args: ConstructorParameters<typeof InputHandler>) {
      handler = new InputHandler(...args);
      return handler;
    }
    // SelectionManager owns the captured pointer and forwards these mouse
    // semantics. The opened-widget pointer suite exercises that wiring.
    function dispatchMouse(event: ReturnType<typeof mouseEvent>) {
      if (event.type === 'wheel') container.dispatchEvent(event);
      else {
        const method = event.type === 'mousedown' ? 'handleMouseDown'
          : event.type === 'mousemove' ? 'handleMouseMove' : 'handleMouseUp';
        handler[method](event as unknown as MouseEvent);
      }
    }
    function mouseConfig(sgr: boolean) {
      return {
        hasMouseTracking: () => true,
        hasSgrMouseMode: () => sgr,
        getCellDimensions: () => ({ width: 10, height: 20 }),
        getCanvasOffset: () => ({ left: 0, top: 0 }),
        getGridDimensions: () => ({ cols: 80, rows: 24 }),
      };
    }

    function mouseEvent(type: string, button: number, shiftKey = false) {
      return {
        type,
        clientX: 5,
        clientY: 5,
        button,
        buttons: type === 'mouseup' ? 0 : [1, 4, 2][button],
        deltaY: -100,
        shiftKey,
        metaKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
    }

    test('mouse coordinates clamp to live grid dimensions at every edge', () => {
      const grid = { cols: 12, rows: 3 };
      const config = { ...mouseConfig(true), getGridDimensions: () => grid };
      createMouseHandler(ghostty, container as any, (data) => dataReceived.push(data),
        vi.fn(), undefined, undefined, (mode) => mode === 1002, undefined, undefined, config);
      dispatchMouse({ ...mouseEvent('mousedown', 0), clientX: -10, clientY: -20 });
      dispatchMouse({ ...mouseEvent('mousemove', 0), clientX: 999, clientY: 999 });
      grid.cols = 7; grid.rows = 2;
      dispatchMouse({ ...mouseEvent('mouseup', 0), clientX: 999, clientY: 999 });
      expect(dataReceived).toEqual(['\x1b[<0;1;1M', '\x1b[<32;12;3M', '\x1b[<0;7;2m']);
    });

    test('reports press and release in SGR mode', () => {
      createMouseHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mouseConfig(true)
      );

      dispatchMouse(mouseEvent('mousedown', 0));
      dispatchMouse(mouseEvent('mouseup', 0));

      // SGR press ends in M and release in m; without the release byte the pair is identical.
      expect(dataReceived).toEqual(['\x1b[<0;1;1M', '\x1b[<0;1;1m']);
    });

    test('reports the non-SGR release as button 3', () => {
      createMouseHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mouseConfig(false)
      );

      dispatchMouse(mouseEvent('mousedown', 0));
      dispatchMouse(mouseEvent('mouseup', 0));

      // The non-SGR release is button 3; without the mapping the release repeats the press bytes. The handler calls this normal-tracking form X10, though ctlseqs' mode 9 reports no release.
      expect(dataReceived).toEqual(['\x1b[M !!', '\x1b[M#!!']);
    });

    test('Shift keeps a gesture from the program while it tracks the mouse', () => {
      createMouseHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (mode) => mode === 1003,
        undefined,
        undefined,
        mouseConfig(true)
      );

      // A Shift press, its drag (Shift let go of mid-drag included) and its
      // release are the terminal's, and so is a Shift wheel or motion.
      dispatchMouse(mouseEvent('mousedown', 0, true));
      dispatchMouse(mouseEvent('mousemove', 0, true));
      dispatchMouse(mouseEvent('mousemove', 0));
      dispatchMouse(mouseEvent('mouseup', 0));
      dispatchMouse(mouseEvent('wheel', 0, true));
      dispatchMouse(mouseEvent('mousemove', 0, true));
      expect(dataReceived).toEqual([]);

      // A press without Shift is the program's to its release, Shift or not.
      dispatchMouse(mouseEvent('mousedown', 0));
      dispatchMouse(mouseEvent('mouseup', 0, true));
      expect(dataReceived).toEqual(['\x1b[<0;1;1M', '\x1b[<4;1;1m']);
    });

    function trackingHandler(mode: number) {
      return createMouseHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (asked) => asked === mode,
        undefined,
        undefined,
        mouseConfig(true)
      );
    }

    test('a press after a Shift press whose release never came is the program\'s whole gesture', () => {
      trackingHandler(1002);
      dispatchMouse(mouseEvent('mousedown', 0, true));
      // Its release lands nowhere the handler listens: a lost release.
      dispatchMouse(mouseEvent('mousedown', 0));
      dispatchMouse(mouseEvent('mousemove', 0));
      dispatchMouse(mouseEvent('mouseup', 0));
      expect(dataReceived).toEqual(['\x1b[<0;1;1M', '\x1b[<32;1;1M', '\x1b[<0;1;1m']);
    });

    test('a completed Shift gesture ends the bypass', () => {
      const handler = trackingHandler(1003);
      dispatchMouse(mouseEvent('mousedown', 0, true));
      dispatchMouse(mouseEvent('mouseup', 0));
      // Motion with no button held is reported again under any-motion tracking.
      dispatchMouse({ ...mouseEvent('mousemove', 0), buttons: 0 });
      handler.dispose();
      expect(dataReceived).toEqual(['\x1b[<32;1;1M']);
    });
  });

  describe('Clipboard Operations', () => {
    test('handles paste event', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const pasteText = 'Hello, World!';
      const pasteEvent = createClipboardEvent(pasteText);

      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('handles beforeinput insertFromPaste with data', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      const pasteText = 'Hello, beforeinput!';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('uses bracketed paste for beforeinput insertFromPaste', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        (mode) => mode === 2004,
        undefined,
        inputElement as any
      );

      const pasteText = 'Bracketed paste';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(`\x1b[200~${pasteText}\x1b[201~`);
    });

    test('handles multi-line paste', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const pasteText = 'Line 1\nLine 2\nLine 3';
      const pasteEvent = createClipboardEvent(pasteText);

      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('ignores beforeinput insertFromPaste when paste already handled', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      const pasteText = 'Hello, World!';
      const pasteEvent = createClipboardEvent(pasteText);
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);

      container.dispatchEvent(pasteEvent);
      inputElement.dispatchEvent(beforeInputEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('ignores paste when beforeinput insertFromPaste already handled', () => {
      const inputElement = createMockContainer();
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        inputElement as any
      );

      const pasteText = 'Hello, World!';
      const beforeInputEvent = createBeforeInputEvent('insertFromPaste', pasteText);
      const pasteEvent = createClipboardEvent(pasteText);

      inputElement.dispatchEvent(beforeInputEvent);
      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(1);
      expect(dataReceived[0]).toBe(pasteText);
    });

    test('ignores paste with no clipboard data', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const pasteEvent = createClipboardEvent(null);

      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(0);
    });

    test('ignores paste with empty text', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      const pasteEvent = createClipboardEvent('');

      container.dispatchEvent(pasteEvent);

      expect(dataReceived.length).toBe(0);
    });

    test('allows Ctrl+V to trigger paste', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Ctrl+V should NOT call onData callback (lets paste event handle it)
      simulateKey(container, createKeyEvent('KeyV', 'v', { ctrl: true }));

      expect(dataReceived.length).toBe(0);
    });

    test('allows Cmd+V to trigger paste', () => {
      new InputHandler(
        ghostty,
        container as any,
        (data) => dataReceived.push(data),
        vi.fn()
      );

      // Cmd+V should NOT call onData callback (lets paste event handle it)
      simulateKey(container, createKeyEvent('KeyV', 'v', { meta: true }));

      expect(dataReceived.length).toBe(0);
    });
  });
});
