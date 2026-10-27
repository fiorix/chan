// The desktop Computers deck: All windows, This machine, the devservers by
// name, Add devserver last. Arrows turn it and
// move focus onto the card in front, every other card is inert, a click brings
// a side card forward, and the Add devserver card turns over to the devserver
// form and back. jsdom has no layout and no inert semantics, so these read the
// deck's state off the DOM it renders: which slot is current, which bodies are
// inert, where focus sits.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Library from "./Library.svelte";
import { openNewDialog, closeDialog } from "../state/dialog.svelte";
import { openCommandLauncher, closeCommandLauncher } from "../state/commandLauncher.svelte";
import { confirm } from "../state/confirm.svelte";
import {
  library,
  loadLibrary,
  removeDevserver,
  saveDevserver,
  stopWatching,
} from "../state/library.svelte";
import { decks, resetDeck } from "../state/deck.svelte";
import { setSelectMode } from "../state/selection.svelte";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;
const added: string[] = [];

function mountDeck(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Library, { target });
  flushSync();
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
  flushSync();
  await tick();
}

function slots(): HTMLElement[] {
  return [...(target?.querySelectorAll<HTMLElement>(".slot") ?? [])];
}

function labels(): string[] {
  return slots().map((s) => s.getAttribute("aria-label") ?? "");
}

function front(): string {
  return target?.querySelector(".slot[aria-current='true']")?.getAttribute("aria-label") ?? "";
}

function press(key: string, on: EventTarget = document.body): void {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

async function addDevserver(label: string, port: number): Promise<void> {
  added.push(await saveDevserver({ host: "127.0.0.1", port, label }));
}

beforeEach(async () => {
  resetDeck();
  library.error = null;
  await loadLibrary();
});

afterEach(async () => {
  setSelectMode(false);
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  for (const id of added.splice(0)) await removeDevserver(id);
});

describe("the Computers deck", () => {
  it("navigates machine headers, terminal rows and workspace rows, including expansion", async () => {
    mountDeck();
    press("ArrowRight");
    await tick();
    const slot = target!.querySelector<HTMLElement>('.slot[data-key="local"]')!;
    const header = slot.querySelector<HTMLElement>(".machine-header")!;
    press("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(header);
    // The window count is text, so the walk starts at the first real control.
    press("ArrowRight", header);
    expect(document.activeElement).toBe(header.querySelector('[aria-label="New local terminal"]'));
    press("ArrowRight", document.activeElement!);
    expect(document.activeElement).toBe(header.querySelector('[aria-label="New local workspace"]'));
    expect(front()).toBe("This machine, 2 of 4");
    press("ArrowDown", document.activeElement!);
    expect(document.activeElement).toBe(slot.querySelector(".term-list .row"));
    press("ArrowDown", document.activeElement!);
    const workspace = slot.querySelector<HTMLElement>(".ws-head")!;
    expect(document.activeElement).toBe(workspace);
    const expand = workspace.querySelector<HTMLButtonElement>(".chevron")!;
    if (expand.getAttribute("aria-expanded") === "true") expand.click();
    flushSync();
    press("Enter", workspace);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    press("ArrowDown", workspace);
    expect(document.activeElement).toBe(workspace.parentElement!.querySelector(".ws-windows .row"));
    press("ArrowUp", document.activeElement!);
    expect(document.activeElement).toBe(workspace);
    expect(slot.querySelector(".machine-content")).not.toBeNull();
  });

  it("walks devserver header controls and selection checkboxes before turning at an edge", async () => {
    setSelectMode(true);
    mountDeck();
    press("ArrowRight");
    press("ArrowRight");
    await tick();
    expect(front()).toBe("prod, 3 of 4");
    press("ArrowDown", document.activeElement!);
    const header = target!.querySelector<HTMLElement>(".slot.active .machine-header")!;
    expect(document.activeElement).toBe(header);
    const controls = [...header.querySelectorAll<HTMLElement>("button, input")].filter((el) => !el.matches(":disabled"));
    expect(controls[0]).toBeInstanceOf(HTMLInputElement);
    for (const control of controls) {
      press("ArrowRight", document.activeElement!);
      expect(document.activeElement).toBe(control);
      expect(front()).toBe("prod, 3 of 4");
    }
    press("ArrowRight", document.activeElement!);
    await tick();
    expect(front()).toBe("Add devserver, 4 of 4");
    press("ArrowDown", document.activeElement!);
    const addRow = target!.querySelector<HTMLElement>(".add-card .front")!;
    expect(document.activeElement).toBe(addRow);
    press("ArrowRight", addRow);
    expect(document.activeElement).toBe(addRow.querySelector("button"));
    press("ArrowRight", document.activeElement!);
    await tick();
    expect(front()).toBe("All windows, 1 of 4");
  });

  it("skips a disabled machine action without rotating the carousel", async () => {
    mountDeck();
    press("ArrowRight");
    await tick();
    press("ArrowDown", document.activeElement!);
    const header = target!.querySelector<HTMLElement>(".slot.active .machine-header")!;
    const terminal = header.querySelector<HTMLButtonElement>('[aria-label="New local terminal"]')!;
    terminal.disabled = true;
    press("ArrowRight", header);
    expect(document.activeElement).toBe(header.querySelector('[aria-label="New local workspace"]'));
    expect(front()).toBe("This machine, 2 of 4");
  });

  it("deals All windows first, then This machine, the devservers by name, and Add devserver last", async () => {
    await addDevserver("zeta", 9101);
    await addDevserver("alpha", 9102);
    mountDeck();
    expect(labels()).toEqual([
      "All windows, 1 of 6",
      "This machine, 2 of 6",
      "alpha, 3 of 6",
      "prod, 4 of 6",
      "zeta, 5 of 6",
      "Add devserver, 6 of 6",
    ]);
    expect(front()).toBe("All windows, 1 of 6");
  });

  it("turns with the arrows, wraps at the ends, and focuses the card in front", async () => {
    mountDeck();
    expect(labels()).toEqual(["All windows, 1 of 4", "This machine, 2 of 4", "prod, 3 of 4", "Add devserver, 4 of 4"]);

    press("ArrowRight");
    await tick();
    expect(front()).toBe("This machine, 2 of 4");
    expect(document.activeElement).toBe(target!.querySelector(".slot[aria-current='true']"));

    press("ArrowLeft");
    press("ArrowLeft");
    await tick();
    expect(front()).toBe("Add devserver, 4 of 4");

    press("ArrowRight");
    expect(front()).toBe("All windows, 1 of 4");
  });

  it("walks a window row's controls before turning the carousel at either edge", async () => {
    mountDeck();
    press("ArrowDown");
    await tick();
    const row = target!.querySelector<HTMLLIElement>(".all-windows li")!;
    expect(document.activeElement).toBe(row);
    const controls = [...row.querySelectorAll<HTMLButtonElement>("button")];
    for (const control of controls) {
      press("ArrowRight", document.activeElement!);
      await tick();
      expect(front()).toBe("All windows, 1 of 4");
      expect(document.activeElement).toBe(control);
    }
    for (const control of controls.slice(0, -1).reverse()) {
      press("ArrowLeft", document.activeElement!);
      await tick();
      expect(front()).toBe("All windows, 1 of 4");
      expect(document.activeElement).toBe(control);
    }
    press("ArrowLeft", document.activeElement!);
    await tick();
    expect(front()).toBe("Add devserver, 4 of 4");
    press("ArrowRight", document.activeElement!);
    await tick();
    controls.at(-1)!.focus();
    press("ArrowRight", document.activeElement!);
    await tick();
    expect(front()).toBe("This machine, 2 of 4");
  });

  it("holds keyboard focus to the card in front", () => {
    mountDeck();
    const bodies = slots().map((s) => s.querySelector<HTMLElement>(".slot-body")!);
    expect(bodies.map((b) => b.inert)).toEqual([false, true, true, true]);
    press("ArrowRight");
    expect(bodies.map((b) => b.inert)).toEqual([true, false, true, true]);
  });

  it("leaves arrows with a modifier, or typed into a field, alone", async () => {
    mountDeck();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
    );
    flushSync();
    expect(front()).toBe("All windows, 1 of 4");

    // Bring the Add devserver card forward and type into its form.
    press("ArrowLeft");
    target!.querySelector<HTMLButtonElement>("button.add-devserver")!.click();
    flushSync();
    await tick();
    const name = target!.querySelector<HTMLInputElement>(".devserver-form input[type=text]")!;
    press("ArrowLeft", name);
    expect(front()).toBe("Add devserver, 4 of 4");
  });

  it("Shift+Left/Right turns directly from row controls and inline form fields", async () => {
    mountDeck();
    const shifted = async (key: string, on: EventTarget = document.activeElement!) => {
      const event = new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true, cancelable: true });
      on.dispatchEvent(event);
      flushSync();
      await tick();
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(target!.querySelector(".slot.active"));
    };
    const rowControl = target!.querySelector<HTMLButtonElement>('.all-windows [aria-label="Focus window"]')!;
    rowControl.focus();
    await shifted("ArrowRight");
    expect(front()).toBe("This machine, 2 of 4");
    const headerControl = target!.querySelector<HTMLButtonElement>('.slot.active [aria-label="New local terminal"]')!;
    headerControl.focus();
    await shifted("ArrowLeft");
    expect(front()).toBe("All windows, 1 of 4");
    await shifted("ArrowLeft");
    expect(front()).toBe("Add devserver, 4 of 4");
    target!.querySelector<HTMLButtonElement>("button.add-devserver")!.click();
    await settleAll();
    const field = target!.querySelector<HTMLInputElement>(".devserver-form input")!;
    field.focus();
    await shifted("ArrowRight");
    expect(front()).toBe("All windows, 1 of 4");
  });

  it("keeps Shift+Up/Down and additional modifiers out of carousel navigation", () => {
    mountDeck();
    for (const init of [
      { key: "ArrowUp", shiftKey: true },
      { key: "ArrowDown", shiftKey: true },
      { key: "ArrowRight", shiftKey: true, ctrlKey: true },
      { key: "ArrowLeft", shiftKey: true, metaKey: true },
      { key: "ArrowRight", shiftKey: true, altKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      flushSync();
      expect(event.defaultPrevented).toBe(false);
      expect(front()).toBe("All windows, 1 of 4");
    }
  });

  it("brings a side card forward on a click", async () => {
    mountDeck();
    slots()[1].click();
    flushSync();
    await tick();
    expect(front()).toBe("This machine, 2 of 4");
    expect(document.activeElement).toBe(slots()[1]);
  });

  it("keeps the card in front across a remount", () => {
    mountDeck();
    press("ArrowRight");
    unmount(app!);
    target!.remove();
    mountDeck();
    expect(front()).toBe("This machine, 2 of 4");
    expect(decks.computers.activeKey).toBe("local");
  });
});

describe("the Add devserver card", () => {
  // The click comes after the arrow that brought the card forward has moved
  // focus onto it, as a person's would.
  async function openForm(): Promise<void> {
    await tick();
    target!.querySelector<HTMLButtonElement>("button.add-devserver")!.click();
    flushSync();
  }

  function form(): HTMLElement | null {
    return target!.querySelector(".add-deck-card .devserver-form");
  }

  it("turns over to the devserver form, and Escape turns it back", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    await tick();
    expect(form()).not.toBeNull();
    expect(document.activeElement).toBe(form()!.querySelector("input[type=text]"));

    press("Escape", form()!.querySelector("input[type=text]")!);
    await settleAll();
    expect(form()).toBeNull();
    expect(document.activeElement).toBe(target!.querySelector("button.add-devserver"));
  });

  it("Cancel turns it back without adding a devserver", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    const before = library.devservers.length;
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel")!.click();
    flushSync();
    await tick();
    expect(form()).toBeNull();
    expect(library.devservers.length).toBe(before);
  });

  it("adds the devserver, deals its card by name, and brings it to the front", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    const [name, address] = form()!.querySelectorAll<HTMLInputElement>("input[type=text]");
    name.value = "beta";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    address.value = "127.0.0.1:9200";
    address.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add devserver")!.click();
    await settleAll();

    const beta = library.devservers.find((d) => d.label === "beta");
    expect(beta).toBeDefined();
    added.push(beta!.id);
    expect(labels()).toEqual([
      "All windows, 1 of 5",
      "This machine, 2 of 5",
      "beta, 3 of 5",
      "prod, 4 of 5",
      "Add devserver, 5 of 5",
    ]);
    expect(front()).toBe("beta, 3 of 5");
    expect(document.activeElement).toBe(target!.querySelector(".slot[aria-current='true']"));
    // The Add devserver card is back on its front face, ready for the next one.
    expect(form()).toBeNull();
  });

  it("keeps the form up with the error when the address does not parse", async () => {
    mountDeck();
    press("ArrowLeft");
    await openForm();
    [...form()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add devserver")!.click();
    await settleAll();
    expect(form()?.querySelector('[role="alert"]')?.textContent).toContain("Enter an address");
    expect(front()).toBe("Add devserver, 4 of 4");
  });
});

describe("the Computers deck's letter actions", () => {
  function key(key: string, on: EventTarget, extra: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    on.dispatchEvent(event);
    flushSync();
    return event;
  }

  function watchClick(button: HTMLButtonElement): ReturnType<typeof vi.fn> {
    const clicked = vi.fn((event: Event) => event.stopImmediatePropagation());
    button.addEventListener("click", clicked);
    return clicked;
  }

  it("t opens a terminal on local and connected devserver headers; c presses the connection control", async () => {
    mountDeck();
    for (const card of ["local", "ds-1"]) {
      decks.computers.activeKey = card;
      flushSync();
      const header = target!.querySelector<HTMLElement>(`.slot[data-key="${card}"] .machine-header`)!;
      const terminal = header.querySelector<HTMLButtonElement>('[aria-label^="New"][aria-label*="terminal"]')!;
      const opened = watchClick(terminal);
      key("t", header);
      key("T", terminal, { shiftKey: true });
      key("t", header, { repeat: true });
      expect(opened).toHaveBeenCalledTimes(2);
      const connection = header.querySelector<HTMLButtonElement>('[aria-label^="Disconnect"]');
      if (connection) {
        const toggled = watchClick(connection);
        key("c", header);
        expect(toggled).toHaveBeenCalledOnce();
      } else expect(key("c", header).defaultPrevented).toBe(false);
    }
  });

  it("c connects a disconnected devserver and respects its disabled control", async () => {
    await addDevserver("letter-connect", 19901);
    const ds = library.devservers.find((d) => d.label === "letter-connect")!;
    mountDeck();
    decks.computers.activeKey = ds.id;
    flushSync();
    const header = target!.querySelector<HTMLElement>(`.slot[data-key="${ds.id}"] .machine-header`)!;
    const connect = header.querySelector<HTMLButtonElement>('[aria-label^="Connect"]')!;
    const clicked = watchClick(connect);
    key("c", header);
    expect(clicked).toHaveBeenCalledOnce();
    connect.disabled = true;
    expect(key("c", header).defaultPrevented).toBe(false);
    expect(clicked).toHaveBeenCalledOnce();
    expect(key("t", header).defaultPrevented).toBe(false);
  });

  it("w opens only an enabled workspace row and h toggles only window rows", async () => {
    mountDeck();
    decks.computers.activeKey = "local";
    flushSync();
    const slot = target!.querySelector<HTMLElement>('.slot[data-key="local"]')!;
    const workspace = slot.querySelector<HTMLElement>(".ws-head")!;
    const open = workspace.querySelector<HTMLButtonElement>('[aria-label^="New window of"]')!;
    const opened = watchClick(open);
    key("w", workspace);
    expect(opened).toHaveBeenCalledOnce();
    open.disabled = true;
    expect(key("w", workspace).defaultPrevented).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
    expect(key("c", workspace).defaultPrevented).toBe(false);
    expect(key("t", workspace).defaultPrevented).toBe(false);
    expect(key("h", workspace).defaultPrevented).toBe(false);
    const row = slot.querySelector<HTMLElement>(".term-list .row")!;
    const toggle = row.querySelector<HTMLButtonElement>('[aria-label="Hide window"]')!;
    const toggled = watchClick(toggle);
    key("h", row);
    expect(toggled).toHaveBeenCalledOnce();
    expect(key("w", row).defaultPrevented).toBe(false);
    expect(key("h", slot.querySelector(".machine-header")!).defaultPrevented).toBe(false);
  });

  it("All windows rows use h for shown, hidden, workspace and control windows, and ignore t, w and c", () => {
    mountDeck();
    const rows = [...target!.querySelectorAll<HTMLElement>(".all-windows [data-window-id]")];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      const toggle = row.querySelector<HTMLButtonElement>('[aria-label^="Show window"], [aria-label^="Hide window"]')!;
      const clicked = watchClick(toggle);
      for (const letter of ["t", "w", "c"]) expect(key(letter, row).defaultPrevented).toBe(false);
      key("h", row);
      expect(clicked).toHaveBeenCalledOnce();
    }
  });

  it("does not act under dialogs, the command launcher, inert ancestors or consumed events", () => {
    mountDeck();
    decks.computers.activeKey = "local";
    flushSync();
    const header = target!.querySelector<HTMLElement>('.slot[data-key="local"] .machine-header')!;
    const terminal = header.querySelector<HTMLButtonElement>('[aria-label="New local terminal"]')!;
    const clicked = watchClick(terminal);
    openNewDialog("local");
    key("t", header);
    closeDialog();
    confirm.open = true;
    key("t", header);
    confirm.open = false;
    openCommandLauncher("computers");
    key("t", header);
    closeCommandLauncher();
    target!.setAttribute("inert", "");
    key("t", header);
    target!.removeAttribute("inert");
    const consumed = new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true });
    consumed.preventDefault();
    header.dispatchEvent(consumed);
    expect(clicked).not.toHaveBeenCalled();
    key("t", header);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("h hides and shows the same All windows record through its normal action", async () => {
    mountDeck();
    const row = target!.querySelector<HTMLElement>('.all-windows [data-window-id="w-local-term-1"]')!;
    key("h", row);
    await settleAll();
    expect(library.windows.find((w) => w.window_id === "w-local-term-1")?.hidden).toBe(true);
    key("h", row);
    await settleAll();
    expect(library.windows.find((w) => w.window_id === "w-local-term-1")?.hidden).toBe(false);
  });

  it("leaves fields, modifiers, inactive cards, disabled buttons and repeats alone", async () => {
    mountDeck();
    decks.computers.activeKey = "local";
    flushSync();
    const header = target!.querySelector<HTMLElement>('.slot[data-key="local"] .machine-header')!;
    const terminal = header.querySelector<HTMLButtonElement>('[aria-label="New local terminal"]')!;
    const clicked = watchClick(terminal);
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) key("t", header, { [modifier]: true });
    key("t", header, { repeat: true });
    for (const tag of ["input", "textarea", "select", "div"]) {
      const field = document.createElement(tag);
      if (tag === "div") field.setAttribute("contenteditable", "true");
      header.append(field);
      key("t", field);
      field.remove();
    }
    expect(key("t", target!.querySelector('.slot[data-key="ds-1"] .machine-header')!).defaultPrevented).toBe(false);
    terminal.disabled = true;
    expect(key("t", header).defaultPrevented).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    terminal.disabled = false;
    key("t", header);
    expect(clicked).toHaveBeenCalledOnce();
  });
});
