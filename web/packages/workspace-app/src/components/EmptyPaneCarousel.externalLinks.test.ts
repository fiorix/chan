// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";

const pluginScript = readFileSync("src/components/__tests__/fixtures/opener-init-iife.js", "utf8");
const mounted: Array<Record<string, any>> = [];
let pluginListener: EventListener | undefined;

afterEach(() => {
  if (pluginListener) window.removeEventListener("click", pluginListener);
  pluginListener = undefined;
  for (const component of mounted.splice(0)) unmount(component);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function aboutLinks(): Promise<HTMLAnchorElement[]> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(EmptyPaneCarousel, { target, props: { slide: 2, active: false } }));
  await tick();
  const links = [...target.querySelectorAll<HTMLAnchorElement>(".about-link")];
  expect(links.map((link) => link.href)).toEqual([
    "https://chan.app/",
    "https://github.com/fiorix/chan",
  ]);
  return links;
}

function injectPluginListener(): void {
  const add = vi.spyOn(window, "addEventListener");
  new Function(pluginScript)();
  const call = add.mock.calls.find(([name]) => name === "click");
  expect(call).toBeDefined();
  pluginListener = call![1] as EventListener;
  add.mockRestore();
}

describe("dashboard external links", () => {
  test.each([{}, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }])(
    "routes desktop clicks through chan before the plugin listener: %j",
    async (modifiers) => {
      const links = await aboutLinks();
      const invoke = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
      injectPluginListener();
      for (const link of links) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
        link.querySelector("span")!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(invoke).toHaveBeenLastCalledWith("open_external_url", { url: link.href });
      }
      expect(invoke).toHaveBeenCalledTimes(links.length);
    },
  );

  test("preserves normal browser anchor navigation, including modified clicks", async () => {
    const links = await aboutLinks();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    for (const modifiers of [{}, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }]) {
      for (const link of links) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
        link.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(open).not.toHaveBeenCalled();
  });

  test("does not open a desktop link whose click is already handled", async () => {
    const [link] = await aboutLinks();
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    link.dispatchEvent(event);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("does not turn non-primary desktop clicks into a new open", async () => {
    const [link] = await aboutLinks();
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    for (const button of [1, 2]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  test.each(["main.rs", "terminal_mode.rs"])(
    "disables automatic plugin URL dispatch in %s",
    (file) => {
      const source = readFileSync(`../../../desktop/src-tauri/src/${file}`, "utf8");
      expect(source.includes("tauri_plugin_opener::init()")).toBe(false);
      expect(/tauri_plugin_opener::Builder::new\(\)\s*\.open_js_links_on_click\(false\)\s*\.build\(\)/.test(source)).toBe(true);
    },
  );
});
