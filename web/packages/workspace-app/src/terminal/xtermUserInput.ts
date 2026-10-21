import type { Terminal } from "@xterm/xterm";

// xterm.js marks the data it emits for the user's own input and leaves its
// answers to the program unmarked: `CoreService.triggerDataEvent` fires its
// `onUserInput` event and then `onData`, in one call, for what the keyboard,
// a paste, a composition, the `input` event, an SGR mouse report or
// `Terminal.input` produced, and `onData` alone for a parser reply, a focus
// report or a colour or size report. Each chunk is one call with one flag, so
// a chunk never mixes the two. The public API carries no such flag, so this
// reaches the internal service, as `selectionBypass.ts` does; it is
// feature-detected, and without it the terminal routes its data as it would
// with no chunk marked.

type Disposable = { dispose(): void };
type CoreServiceLike = { onUserInput?: (listener: () => void) => Disposable };
type CoreLike = { coreService?: CoreServiceLike };

export interface UserInputTracker {
  /// Whether the chunk `onData` is handing over was marked as user input,
  /// clearing the mark for the next one.
  take(): boolean;
  dispose(): void;
}

/// Track the user-input mark of `term`'s data, or null when this xterm.js
/// has no such internal event.
export function trackUserInput(term: Terminal): UserInputTracker | null {
  const service = (term as unknown as { _core?: CoreLike })._core?.coreService;
  if (!service || typeof service.onUserInput !== "function") return null;
  let marked = false;
  const subscription = service.onUserInput(() => {
    marked = true;
  });
  return {
    take() {
      const was = marked;
      marked = false;
      return was;
    },
    dispose() {
      subscription.dispose();
    },
  };
}
