// Mounting the Wysiwyg editor in jsdom: the DOM stubs CodeMirror needs, a
// mount that waits for the editor view, and the key and transaction helpers
// the editor tests share.

import type { Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { mount, tick, unmount, type ComponentProps } from "svelte";

import Wysiwyg from "../editor/Wysiwyg.svelte";

/// jsdom has no layout: give CodeMirror empty rects, and stub the observers
/// and media queries the editor and its widgets read on mount.
export function installEditorDom(): void {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Element.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
}

export type WysiwygProps = ComponentProps<typeof Wysiwyg>;

export type MountedWysiwyg = {
  target: HTMLElement;
  view: EditorView;
  content: HTMLElement;
  editor: ReturnType<typeof mount>;
};

const mounted: Array<ReturnType<typeof mount>> = [];

/// Mount Wysiwyg into a fresh element (under `host` when given) and wait for
/// its editor view.
export async function mountWysiwyg(props: WysiwygProps, host?: HTMLElement): Promise<MountedWysiwyg> {
  const target = document.createElement("div");
  (host ?? document.body).append(target);
  const editor = mount(Wysiwyg, { target, props });
  mounted.push(editor);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i += 1) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("Wysiwyg rendered no editor");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no editor view");
  return { target, view, content, editor };
}

export function unmountWysiwygs(): void {
  for (const editor of mounted.splice(0)) unmount(editor);
}

export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

export function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(event);
  return event;
}

/// An extension that records every transaction the view applies, for a test
/// to read which ones a handler dispatched.
export function recordTransactions(): { extension: Extension; transactions: Transaction[] } {
  const transactions: Transaction[] = [];
  return {
    transactions,
    extension: EditorView.updateListener.of((update) => {
      transactions.push(...update.transactions);
    }),
  };
}
