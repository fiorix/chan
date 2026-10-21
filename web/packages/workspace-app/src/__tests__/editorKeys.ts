// Keys through a mounted editor on a chosen platform. CodeMirror reads the
// platform once, when it first loads, and a module Node loads from
// node_modules is not reset by `vi.resetModules()`, so a test file sets its
// platform with `setPlatform` before its first `press`, and one file holds
// one platform; vitest gives each file its own module cache.

export const MAC = "MacIntel";
export const LINUX = "Linux x86_64";

export const KEY_DOC = "- one\n- two\nplain text";
export const ITEM_END = "- one\n- two".length;
export const ITEM_LINE_START = "- one\n".length;
export const ITEM_TEXT_START = "- one\n- ".length;
export const PLAIN_END = KEY_DOC.length;
export const PLAIN_LINE_START = "- one\n- two\n".length;

export const shiftCtrlA = { key: "A", code: "KeyA", keyCode: 65, ctrlKey: true, shiftKey: true };
export const shiftAltA = { key: "A", code: "KeyA", keyCode: 65, altKey: true, shiftKey: true };

export type KeyEditor = "Wysiwyg" | "Source";

let loaded = false;
const unmounts: Array<() => void> = [];

export function setPlatform(platform: string): void {
  if (loaded) throw new Error("the platform is set before CodeMirror loads");
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

export function unmountEditors(): void {
  for (const u of unmounts.splice(0)) u();
  document.body.innerHTML = "";
}

/// Mount one editor over KEY_DOC, put the caret at `at`, press the key, and
/// read the document and the selection.
export async function press(editor: KeyEditor, at: number, init: KeyboardEventInit & { keyCode: number }) {
  loaded = true;
  const { mount, tick, unmount } = await import("svelte");
  const { EditorView } = await import("@codemirror/view");
  const component = editor === "Wysiwyg"
    ? (await import("../editor/Wysiwyg.svelte")).default
    : (await import("../editor/Source.svelte")).default;
  const target = document.createElement("div");
  document.body.append(target);
  const props = editor === "Wysiwyg" ? { value: KEY_DOC, currentPath: "note.md" } : { value: KEY_DOC, path: "note.md" };
  const app = mount(component as never, { target, props });
  unmounts.push(() => unmount(app));
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content)!;
  view.dispatch({ selection: { anchor: at } });
  const { keyCode, ...rest } = init;
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  content.dispatchEvent(event);
  const { anchor, head } = view.state.selection.main;
  return { doc: view.state.doc.toString(), anchor, head };
}
