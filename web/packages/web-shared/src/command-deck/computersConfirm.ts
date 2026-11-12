// The confirmations of the Computers tree that name a number: closing a
// window and turning a workspace off both stop live terminal sessions, and
// each asks once, on the deck's own card, with the count the host reads.
//
// Raising the card reads the count. Confirming reads it again and acts only on
// a number the user has just seen: a count that moved, or a card nothing in
// this page recorded (one restored from a saved draft), asks again instead.

import type { DeckConfirm } from "./model";

/** The two reads and the two acts the confirmations need of a host. */
export interface ComputersConfirmBridge {
  /** How many live terminal sessions a window or a workspace would stop, or
   * null when the host cannot say. */
  liveTerminals(target: "window" | "workspace", key: string): Promise<number | null>;
  /** Close a window whose confirmation the user has accepted. */
  closeWindow(key: string): Promise<void>;
  /** Turn a workspace off. Unforced, it resolves null once the workspace is
   * off, or with the count of live terminal sessions the host refused over;
   * forced, it stops them. */
  turnOff(key: string, force: boolean): Promise<number | null>;
}

/** What a row needs to ask before it runs: the lazy card and the guarded act. */
export interface CountedConfirmation {
  confirm: () => Promise<DeckConfirm>;
  run: () => Promise<void | DeckConfirm>;
}

export interface ComputersConfirmations {
  closeWindow(window: { key: string; name: string }): CountedConfirmation;
  turnOffWorkspace(workspace: { key: string; name: string }): CountedConfirmation;
  /** Drop the readings of every window and workspace not in `keys`, so an
   * object that left the roster and came back is asked about afresh. */
  retain(windows: ReadonlySet<string>, workspaces: ReadonlySet<string>): void;
}

function sessions(count: number): string {
  return `${count} terminal session${count === 1 ? "" : "s"}`;
}

export function closeWindowMessage(count: unknown): string {
  if (typeof count !== "number") return "Open sessions in this window may stop.";
  if (count === 0) return "This window will close.";
  return `${sessions(count)} in this window will stop.`;
}

export function turnOffWorkspaceMessage(count: unknown): string {
  if (typeof count !== "number") return "Open sessions in this workspace may stop.";
  if (count === 0) return "This workspace will turn off.";
  return `${sessions(count)} in this workspace will stop.`;
}

export function createComputersConfirmations(bridge: ComputersConfirmBridge): ComputersConfirmations {
  // The count a card was painted with, and the reading that owns that card,
  // both keyed by the object. A reading that a later one has overtaken keeps
  // its hands off both.
  const recorded = new Map<string, unknown>();
  const readings = new Map<string, number>();

  /// Claim the next reading slot. Every count read takes one before it asks,
  /// so the reading that answers last is the only one still entitled to
  /// describe the card.
  function nextReading(slot: string): number {
    const version = (readings.get(slot) ?? 0) + 1;
    readings.set(slot, version);
    return version;
  }

  async function readCount(target: "window" | "workspace", key: string): Promise<unknown> {
    try {
      return await bridge.liveTerminals(target, key);
    } catch {
      return null;
    }
  }

  function prepare(
    slot: string,
    read: () => Promise<unknown>,
    card: (count: unknown) => DeckConfirm,
  ): () => Promise<DeckConfirm> {
    return async () => {
      const version = nextReading(slot);
      const count = await read();
      if (readings.get(slot) === version) recorded.set(slot, count);
      return card(count);
    };
  }

  /// Whether a fresh count is the one the card on screen names. A reading a
  /// newer one overtook describes a card that is no longer there, and a count
  /// nothing recorded or that moved has not been seen, so neither may act.
  function seen(slot: string, version: number, fresh: unknown): boolean {
    if (readings.get(slot) !== version) return false;
    if (recorded.has(slot) && recorded.get(slot) === fresh) return true;
    recorded.set(slot, fresh);
    return false;
  }

  return {
    closeWindow(window) {
      const slot = `window:${window.key}`;
      const card = (count: unknown): DeckConfirm => ({
        title: `Close ${window.name}?`,
        message: closeWindowMessage(count),
        actionLabel: "Close",
        danger: true,
      });
      const read = (): Promise<unknown> => readCount("window", window.key);
      return {
        confirm: prepare(slot, read, card),
        run: async () => {
          const version = nextReading(slot);
          const fresh = await read();
          if (!seen(slot, version, fresh)) return card(fresh);
          recorded.delete(slot);
          await bridge.closeWindow(window.key);
        },
      };
    },

    turnOffWorkspace(workspace) {
      const slot = `workspace:${workspace.key}`;
      const card = (count: unknown): DeckConfirm => ({
        title: `Turn off ${workspace.name}?`,
        message: turnOffWorkspaceMessage(count),
        actionLabel: "Turn off",
        danger: true,
      });
      return {
        confirm: prepare(slot, () => readCount("workspace", workspace.key), card),
        // The host's own refusal is the second reading: an unforced off either
        // lands, when nothing would stop, or answers with the count it refused
        // over. Only a count the card named is forced past.
        run: async () => {
          const version = nextReading(slot);
          const live = await bridge.turnOff(workspace.key, false);
          if (live === null) {
            recorded.delete(slot);
            return;
          }
          if (!seen(slot, version, live)) return card(live);
          recorded.delete(slot);
          await bridge.turnOff(workspace.key, true);
        },
      };
    },

    retain(windows, workspaces) {
      const gone = (slot: string): boolean => {
        const at = slot.indexOf(":");
        const keys = slot.slice(0, at) === "window" ? windows : workspaces;
        return !keys.has(slot.slice(at + 1));
      };
      for (const slot of [...recorded.keys()]) if (gone(slot)) recorded.delete(slot);
      for (const slot of [...readings.keys()]) if (gone(slot)) readings.delete(slot);
    },
  };
}
