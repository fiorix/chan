// @vitest-environment jsdom
// R3: a Wysiwyg host with no `onSubmit` (the file editor) must NOT insert a
// blank line on Cmd/Ctrl+Enter. The chord is consumed as a no-op instead of
// falling through to CM6's default Mod-Enter (insertBlankLine). With an
// `onSubmit` wired (a chat-style host) the chord still submits.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import Wysiwyg from "./Wysiwyg.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
});

async function mountWysiwyg(props: {
  value: string;
  currentPath?: string | null;
  onSubmit?: () => void;
  /// Optional parent element to mount into (the deck tests mount inside
  /// an `.editor-host` div carrying a capture listener, mirroring
  /// FileEditorTab's template).
  host?: HTMLElement;
}): Promise<{ content: HTMLElement; view: EditorView }> {
  const { host, ...wysiwygProps } = props;
  const target = document.createElement("div");
  (host ?? document.body).appendChild(target);
  mounted.push(mount(Wysiwyg, { target, props: wysiwygProps }) as Record<string, unknown>);
  for (let i = 0; i < 10 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content) as EditorView;
  return { content, view };
}

function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

describe("R3: Mod-Enter in a no-onSubmit Wysiwyg host (the file editor)", () => {
  test("Cmd/Ctrl+Enter on a plain line does NOT insert a blank line", async () => {
    const { content, view } = await mountWysiwyg({ value: "hello world", currentPath: "note.md" });
    await tick();
    view.dispatch({ selection: { anchor: 5 } });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    press(content, "Enter", { metaKey: true });
    await tick();
    expect(view.state.doc.toString()).toBe(before); // consumed, no blank line
  });

  test("with onSubmit wired, Mod-Enter submits once and leaves the doc unchanged", async () => {
    const onSubmit = vi.fn();
    const { content, view } = await mountWysiwyg({
      value: "hello world",
      currentPath: "note.md",
      onSubmit,
    });
    await tick();
    view.dispatch({ selection: { anchor: 5 } });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    press(content, "Enter", { metaKey: true });
    await tick();
    expect(view.state.doc.toString()).toBe(before);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// A pasted image leaves its atom ring-selected (caret at the atom edge),
// and the image widget's document-level keydown listener treats a bubbling
// Mod-Enter as the View chord (fullscreen zoom). A chat host's submit must
// consume the chord entirely; the file editor keeps the bubbling on purpose
// (ring + Mod-Enter View is the feature there).
describe("Mod-Enter with a ring-selected image", () => {
  const IMG_DOC = "![](photo.png#w=250)\nhello";
  const ATOM_END = "![](photo.png#w=250)".length;

  afterEach(() => {
    for (const el of document.querySelectorAll(".md-image-zoom")) el.remove();
  });

  async function ringSelect(view: EditorView, content: HTMLElement): Promise<HTMLElement | null> {
    view.dispatch({ selection: { anchor: ATOM_END } });
    await tick();
    await Promise.resolve();
    return content
      .closest(".cm-editor")
      ?.querySelector<HTMLElement>(".cm-md-image-wrap[data-selected]") ?? null;
  }

  test("chat host: submit does NOT open the image zoom", async () => {
    const onSubmit = vi.fn();
    const { content, view } = await mountWysiwyg({
      value: IMG_DOC,
      currentPath: "note.md",
      onSubmit,
    });
    await tick();
    const ring = await ringSelect(view, content);
    expect(ring, "image atom must be ring-selected before the chord").toBeTruthy();
    press(content, "Enter", { ctrlKey: true });
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".md-image-zoom")).toBeNull();
  });

  test("file editor: the ring + Mod-Enter View chord still opens the zoom", async () => {
    const { content, view } = await mountWysiwyg({
      value: IMG_DOC,
      currentPath: "note.md",
    });
    await tick();
    const ring = await ringSelect(view, content);
    expect(ring, "image atom must be ring-selected before the chord").toBeTruthy();
    press(content, "Enter", { ctrlKey: true });
    await tick();
    expect(document.querySelector(".md-image-zoom")).toBeTruthy();
  });
});

// The deck's Mod+Enter claim is an element-capture listener on the
// `.editor-host` div (FileEditorTab.svelte's onSlideShortcutKeydown; the
// mount's existence on both hosts is source-pinned by
// components/slideShortcuts.test.ts). These tests mount a real CodeMirror
// inside a host carrying a capture listener of the SAME shape and pin the
// ordering contract the Mod-Enter pile-up depends on: exactly one claimant
// runs per press, and the claim never covers a chord it is not advertised
// as holding.
describe("deck capture claim and the Mod-Enter pile-up", () => {
  const DECK_DOC = [
    "---",
    "chan:",
    "  kind: slides",
    "---",
    "",
    "# Slide 1",
    "",
    "- a",
    "  - b",
    "",
  ].join("\n");

  /// Mirror of the production claim's shape: Enter + the platform Mod
  /// (Ctrl here; jsdom's UA is not a Mac), no Alt -> preventDefault +
  /// stopPropagation + the deck action. Deliberately NOT matching by
  /// resolved chord: the claim covers only this built-in shape, which is
  /// the containment the second test pins. The mirror does NOT carry the
  /// real handler's other gates (slidesSpec, tab.loading, the single
  /// OS-resolved Mod, shouldIgnoreSlideShortcutTarget,
  /// builtInChordSuperseded, the Shift routing to present vs preview);
  /// those are source-pinned by components/slideShortcuts.test.ts, so
  /// green here says nothing about them.
  function deckClaim(action: () => void): (e: KeyboardEvent) => void {
    return (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
  }

  function mountDeckHost(action: () => void): HTMLElement {
    const host = document.createElement("div");
    host.className = "editor-host";
    host.addEventListener("keydown", deckClaim(action), true);
    document.body.appendChild(host);
    return host;
  }

  const strayHosts: HTMLElement[] = [];
  const docListeners: Array<() => void> = [];
  afterEach(() => {
    for (const h of strayHosts.splice(0)) h.remove();
    for (const off of docListeners.splice(0)) off();
    for (const el of document.querySelectorAll(".md-date-popover")) el.remove();
  });

  test("on a deck the claim consumes Mod+Enter ahead of CodeMirror, and nothing reaches document", async () => {
    const deckOpens: string[] = [];
    const tripwire: string[] = [];
    const host = mountDeckHost(() => deckOpens.push("deck"));
    strayHosts.push(host);
    // A document-level listener stands in for every bubble-phase claimant
    // (the override dispatch, the image widget's View chord): if the
    // capture claim stops doing its job, one press reaches them and the
    // deck action double-fires with whatever they run.
    const trip = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) tripwire.push("hit");
    };
    document.addEventListener("keydown", trip);
    docListeners.push(() => document.removeEventListener("keydown", trip));

    const { content, view } = await mountWysiwyg({
      value: DECK_DOC,
      currentPath: "deck.md",
      host,
    });
    await tick();
    view.dispatch({ selection: { anchor: DECK_DOC.indexOf("Slide 1") } });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    press(content, "Enter", { metaKey: true });
    press(content, "Enter", { ctrlKey: true, shiftKey: true });
    await tick();
    // One press = one deck action, nothing else ran, document untouched.
    expect(deckOpens).toEqual(["deck", "deck", "deck"]);
    expect(tripwire).toEqual([]);
    expect(view.state.doc.toString()).toBe(before);
  });

  test("a chord the claim does not hold (Shift+Tab) still reaches CodeMirror on a deck", async () => {
    // The containment acceptance line: assign a deck action a chord
    // CodeMirror uses and the registry does not, and list outdent must
    // still run. The claim covers only Enter+Mod, so Shift+Tab passes
    // it by; the outdent below is the proof CodeMirror saw the key.
    const deckOpens: string[] = [];
    const host = mountDeckHost(() => deckOpens.push("deck"));
    strayHosts.push(host);
    const { content, view } = await mountWysiwyg({
      value: DECK_DOC,
      currentPath: "deck.md",
      host,
    });
    await tick();
    const nested = DECK_DOC.indexOf("- b");
    view.dispatch({ selection: { anchor: nested + 2 } });
    await tick();
    press(content, "Tab", { shiftKey: true });
    await tick();
    expect(deckOpens).toEqual([]);
    expect(view.state.doc.toString()).toBe(DECK_DOC.replace("  - b", "- b"));
  });

  test("on a non-deck file, Mod+Enter on a date pill opens the calendar and nothing else", async () => {
    const deckOpens: string[] = [];
    const host = document.createElement("div");
    host.className = "editor-host";
    // No capture listener: a non-deck file's handler bails on !slidesSpec,
    // so the host behaves as if the claim were absent.
    strayHosts.push(host);
    const { content, view } = await mountWysiwyg({
      value: "due 2026-08-11 soon",
      currentPath: "note.md",
      host,
    });
    await tick();
    view.dispatch({ selection: { anchor: "due 2026-08-1".length } });
    // jsdom has no layout, so coordsAtPos returns null and the popover's
    // anchor mount would bail. Mock the geometry seam only; the matcher,
    // the keymap chain, and the popover mount all run for real.
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 10,
    });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    await tick();
    await Promise.resolve();
    expect(document.querySelector(".md-date-popover"), "calendar popover").toBeTruthy();
    expect(view.state.doc.toString()).toBe(before);
    expect(deckOpens).toEqual([]);
    expect(document.querySelector(".md-image-zoom")).toBeNull();
  });
});
