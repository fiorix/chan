// @vitest-environment jsdom

import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { language, type LanguageSupport } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
// @ts-expect-error Svelte publishes no type for the reactive prop proxy used by its rune transform.
import { proxy } from "svelte/internal/client";
import { afterEach, expect, test, vi } from "vitest";
import { installEditorDom } from "../__tests__/wysiwyg";
import Source from "./Source.svelte";

const loads = vi.hoisted(() => ({ rust: vi.fn(), python: vi.fn() }));
vi.mock("./markdown/code_languages", () => ({
  codeLanguages: [
    { name: "rust", extensions: ["rs"], load: () => loads.rust() },
    { name: "python", extensions: ["py"], load: () => loads.python() },
  ],
}));

installEditorDom();

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function deferred(): { promise: Promise<LanguageSupport>; resolve(value: LanguageSupport): void } {
  let resolve!: (value: LanguageSupport) => void;
  const promise = new Promise<LanguageSupport>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("an earlier language load cannot replace the current path's language", async () => {
  const rustLoad = deferred();
  const pythonLoad = deferred();
  loads.rust.mockReturnValue(rustLoad.promise);
  loads.python.mockReturnValue(pythonLoad.promise);
  const props = proxy({ autoFocus: false, path: "a.rs", value: "text" });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Source, { target, props: props as ComponentProps<typeof Source> }));
  flushSync();
  const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-editor")!)!;
  expect(loads.rust).toHaveBeenCalled();

  props.path = "a.py";
  flushSync();
  expect(loads.python).toHaveBeenCalled();
  const pythonSupport = python();
  pythonLoad.resolve(pythonSupport);
  await flushMicrotasks();
  expect(view.state.facet(language)).toBe(pythonSupport.language);

  rustLoad.resolve(rust());
  await flushMicrotasks();
  expect(view.state.facet(language)?.name, "the latest path must keep its language").toBe(pythonSupport.language.name);
});
