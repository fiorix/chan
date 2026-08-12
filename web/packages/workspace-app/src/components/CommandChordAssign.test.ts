// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate from the real catalog (install pulls every lane's module).
vi.mock("../state/commands/install", () => ({}));

import CommandChordAssign from "./CommandChordAssign.svelte";
import { allCommands, registerCommands, type Command } from "../state/commands";
import { chordFor, chordsEqual } from "../state/shortcuts";
import {
  assignOverride,
  hydrateOverrides,
  overrideChordFor,
  overrideChordForSlot,
  registerOverridePersist,
  resolvedKeymapEntriesForSlot,
  type OverrideSlot,
} from "../state/keymapOverrides.svelte";

function cmd(id: string, title: string, extra: Partial<Command> = {}): Command {
  return {
    id,
    title,
    category: "Global",
    available: () => true,
    run: () => {},
    ...extra,
  };
}

// A chorded command (real SHORTCUTS id), a chordless one, and the deck
// preview, which is a catalog command in production too; a swap is only
// offered for holders whose dispatch resolves through the override layer,
// which is exactly the catalog.
registerCommands([
  cmd("app.window.reload", "Reload"),
  cmd("app.custom.demo", "Demo"),
  cmd("app.slides.preview", "Preview slide deck"),
]);

const mounted: Array<Record<string, unknown>> = [];

async function flush(): Promise<void> {
  await tick();
  await tick();
}

function mountAssign(command: Command, slot?: OverrideSlot): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  const props = slot ? { cmd: command, slot } : { cmd: command };
  mounted.push(
    mount(CommandChordAssign, { target, props }) as Record<string, unknown>,
  );
  return target;
}

function key(target: HTMLElement, init: KeyboardEventInit): void {
  const el = target.querySelector(".capture") as HTMLElement;
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

describe("CommandChordAssign", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    // These tests exercise the assign UI, not persistence; disable the
    // config-write persist (store.svelte registers the real one on import)
    // so an assign does not fire an unmocked /api/config PATCH.
    registerOverridePersist(null);
  });
  afterEach(() => {
    for (const c of mounted.splice(0)) unmount(c);
    document.body.innerHTML = "";
    hydrateOverrides(null);
    vi.unstubAllGlobals();
  });

  test("shows the built-in chord for a chorded command", () => {
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    const btn = target.querySelector(".chord-btn") as HTMLElement;
    expect(btn.textContent?.trim()).toBe("Cmd+R");
    expect(target.querySelector(".reset")).toBeNull();
  });

  test("shows Assign for a command with no chord", () => {
    const target = mountAssign(cmd("app.custom.demo", "Demo"));
    expect((target.querySelector(".chord-btn") as HTMLElement).textContent?.trim()).toBe(
      "Assign",
    );
  });

  test("renders read-only shortcut aliases without an assign affordance", () => {
    const command = cmd("app.pane.kill", "Close pane", {
      shortcutEditable: false,
      shortcutIds: ["app.tab.close", "app.window.close"],
    });
    // The alias pair resolves per slot: Cmd+W / Cmd+Shift+W on macOS;
    // Ctrl+Shift+W / Ctrl+Alt+W on the Linux and Windows desktop.
    for (const [slot, expected] of [
      ["macos", "Cmd+W / Cmd+Shift+W"],
      ["linux", "Ctrl+Shift+W / Ctrl+Alt+W"],
      ["windows", "Ctrl+Shift+W / Ctrl+Alt+W"],
    ] as const) {
      const target = mountAssign(command, slot);
      const chord = target.querySelector(".chord-btn") as HTMLElement;
      expect(chord.tagName, slot).toBe("SPAN");
      expect(chord.classList.contains("readonly"), slot).toBe(true);
      expect(chord.textContent?.trim(), slot).toBe(expected);
      expect(target.querySelector(".reset"), slot).toBeNull();
    }
  });

  test("capturing a free chord assigns it and reveals a reset control", async () => {
    const command = cmd("app.custom.demo", "Demo");
    const target = mountAssign(command);
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();
    expect(target.querySelector(".capture")).not.toBeNull();

    key(target, { key: "j", metaKey: true });
    await flush();

    expect(overrideChordFor("app.custom.demo")).toBe("Mod+J");
    const btn = target.querySelector(".chord-btn") as HTMLElement;
    expect(btn.textContent?.trim()).toBe("Cmd+J");
    expect(target.querySelector(".reset")).not.toBeNull();
  });

  test("a conflicting chord is reported and not assigned", async () => {
    // Reload already holds Cmd+R (its built-in); try to bind it to Demo.
    const command = cmd("app.custom.demo", "Demo");
    const target = mountAssign(command);
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();

    key(target, { key: "r", metaKey: true });
    await flush();

    const capture = target.querySelector(".capture") as HTMLElement;
    expect(capture).not.toBeNull(); // still capturing, not committed
    expect(capture.classList.contains("conflict")).toBe(true);
    expect(capture.textContent).toContain("In use by Reload");
    expect(overrideChordFor("app.custom.demo")).toBeUndefined();
    // Demo holds no chord to give, so no swap can be offered: a swap
    // here would leave Reload with nothing, and "unbound" is not a
    // representable state.
    expect(target.querySelector(".swap")).toBeNull();
  });

  test("a conflict on a chorded command offers a swap that exchanges both chords", async () => {
    // Reload holds Cmd+R; Preview slide deck holds Cmd+Enter. Capturing
    // Cmd+Enter for Reload conflicts - and Reload has a chord to give.
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();

    key(target, { key: "Enter", metaKey: true });
    await flush();

    const capture = target.querySelector(".capture") as HTMLElement;
    expect(capture).not.toBeNull(); // refusal path intact: capture held open
    expect(capture.classList.contains("conflict")).toBe(true);
    expect(capture.textContent).toContain("In use by Preview slide deck");

    const swap = target.querySelector(".swap") as HTMLElement;
    expect(swap).not.toBeNull();
    swap.click();
    await flush();

    // One gesture exchanged the chords: Reload took Cmd+Enter, the deck
    // preview took Reload's Cmd+R. Both commands stay chorded.
    expect(overrideChordForSlot("app.window.reload", "web")).toBe("Mod+Enter");
    expect(overrideChordForSlot("app.slides.preview", "web")).toBe("Mod+R");
    expect(target.querySelector(".capture")).toBeNull(); // capture committed
    expect((target.querySelector(".chord-btn") as HTMLElement).textContent?.trim()).toBe(
      "Cmd+Enter",
    );
  });

  test("a swap introduces no new chord collision in any slot", () => {
    // The user-override analogue of the registry-uniqueness invariant.
    // The invariant is asserted as a DELTA: the built-in table already
    // contains at least one deliberate duplicate (app.find.open and
    // terminal.find both hold Mod+F on the macos slot), so absolute
    // uniqueness is not today's baseline and is not this item's to fix.
    // What a swap must not do is ADD a collision.
    const duplicatePairs = (slot: OverrideSlot): Set<string> => {
      const entries = resolvedKeymapEntriesForSlot(allCommands(), slot);
      const pairs = new Set<string>();
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (chordsEqual(entries[i].chord, entries[j].chord)) {
            pairs.add(`${entries[i].id}\0${entries[j].id}`);
          }
        }
      }
      return pairs;
    };
    const slots: OverrideSlot[] = ["web", "macos", "linux", "windows"];
    const before = new Map(slots.map((slot) => [slot, duplicatePairs(slot)]));

    // Compose the swap the dialog performs: the holder takes the
    // target's chord, then the target takes the captured chord.
    assignOverride("app.slides.preview", "Mod+R", "web");
    assignOverride("app.window.reload", "Mod+Enter", "web");

    for (const slot of slots) {
      const added = [...duplicatePairs(slot)].filter(
        (pair) => !before.get(slot)?.has(pair),
      );
      expect(added, `${slot} gained a collision`).toEqual([]);
    }
    // And the swap actually moved both commands (the delta assertion is
    // vacuous if the swap never happened).
    expect(overrideChordForSlot("app.window.reload", "web")).toBe("Mod+Enter");
    expect(overrideChordForSlot("app.slides.preview", "web")).toBe("Mod+R");
  });

  test("a chord held by two commands reports the conflict but offers no swap", async () => {
    // Demo takes an override onto the deck preview's Mod+Enter, so the
    // captured chord now has TWO holders. A swap exchanges with exactly
    // one of them, so accepting it would settle one holder and ship a
    // fresh collision with the other; the offer must not exist.
    assignOverride("app.custom.demo", "Mod+Enter", "web");
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();

    key(target, { key: "Enter", metaKey: true });
    await flush();

    const capture = target.querySelector(".capture") as HTMLElement;
    expect(capture.classList.contains("conflict")).toBe(true);
    expect(target.querySelector(".swap")).toBeNull();
    // Nothing moved: both holders keep the chord, Reload keeps its own.
    expect(overrideChordForSlot("app.custom.demo", "web")).toBe("Mod+Enter");
    expect(overrideChordForSlot("app.slides.preview", "web")).toBeUndefined();
    expect(overrideChordForSlot("app.window.reload", "web")).toBeUndefined();
  });

  test("a registry-only holder reports the conflict but offers no swap", async () => {
    // Mod+B belongs to the editor's bold chord, a SHORTCUTS entry with no
    // catalog command. Its dispatch lives in the editor keymap and never
    // consults overrides, so a swap would display bold as moved while
    // Mod+B keeps toggling bold and the swapped-in chord fires nothing.
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();

    key(target, { key: "b", metaKey: true });
    await flush();

    const capture = target.querySelector(".capture") as HTMLElement;
    expect(capture).not.toBeNull();
    expect(capture.classList.contains("conflict")).toBe(true);
    expect(target.querySelector(".swap")).toBeNull();
    expect(overrideChordForSlot("app.window.reload", "web")).toBeUndefined();
  });

  test("a free chord pressed after a conflict assigns normally, with no swap", async () => {
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();

    key(target, { key: "Enter", metaKey: true }); // conflict, swap offered
    await flush();
    expect(target.querySelector(".swap")).not.toBeNull();

    key(target, { key: "j", metaKey: true }); // a free chord instead
    await flush();

    expect(overrideChordForSlot("app.window.reload", "web")).toBe("Mod+J");
    // The declined swap did not touch the holding command.
    expect(overrideChordForSlot("app.slides.preview", "web")).toBeUndefined();
    expect(chordFor("app.slides.preview")).toBe("Cmd+Enter");
  });

  test("reset clears the override back to the built-in", async () => {
    assignOverride("app.window.reload", "Mod+J");
    const target = mountAssign(cmd("app.window.reload", "Reload"));
    expect((target.querySelector(".chord-btn") as HTMLElement).textContent?.trim()).toBe(
      "Cmd+J",
    );
    (target.querySelector(".reset") as HTMLElement).click();
    await flush();
    expect(overrideChordFor("app.window.reload")).toBeUndefined();
    expect(chordFor("app.window.reload")).toBe("Cmd+R");
  });

  test("an explicit slot assigns that OS only, leaving the client slot alone", async () => {
    // A mac browser (web slot) editing the linux column via the grid.
    const command = cmd("app.custom.demo", "Demo");
    const target = mountAssign(command, "linux");
    // The linux cell shows the linux built-in? Demo is chordless -> Assign.
    expect((target.querySelector(".chord-btn") as HTMLElement).textContent?.trim()).toBe(
      "Assign",
    );
    (target.querySelector(".chord-btn") as HTMLElement).click();
    await flush();
    key(target, { key: "j", metaKey: true });
    await flush();
    expect(overrideChordForSlot("app.custom.demo", "linux")).toBe("Mod+J");
    // The web slot (this client) is untouched.
    expect(overrideChordForSlot("app.custom.demo", "web")).toBeUndefined();
    // The cell renders the linux label (Ctrl+J), not the mac Cmd+J.
    expect((target.querySelector(".chord-btn") as HTMLElement).textContent?.trim()).toBe(
      "Ctrl+J",
    );
  });
});
