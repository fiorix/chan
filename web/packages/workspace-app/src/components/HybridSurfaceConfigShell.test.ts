// @vitest-environment jsdom
//
// The shell around a Hybrid surface's configuration back: a titled section
// whose footer holds OK. Surface themes are set in Settings, not here, so the
// shell carries no theme control. It is mounted with and without a body.

import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import HybridSurfaceConfigShell from "./HybridSurfaceConfigShell.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
});

function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(HybridSurfaceConfigShell, { target, props: { title: "Editor", ...props } }));
  flushSync();
  return target;
}

describe("the Hybrid config shell", () => {
  test("titles the section and renders the body it is given", () => {
    const children = createRawSnippet(() => ({ render: () => `<p class="body-probe">fields</p>` }));
    const target = render({ children });
    const section = target.querySelector("section.hybrid-config")!;
    expect(section.getAttribute("aria-label")).toBe("Editor configuration");
    expect(section.querySelector(".config-title")?.textContent).toBe("Editor");
    expect(section.querySelector(".config-body .body-probe")?.textContent).toBe("fields");
  });

  test("its footer's OK hands the close to the host", () => {
    const onDone = vi.fn();
    const target = render({ onDone });
    const ok = target.querySelector<HTMLButtonElement>(".config-footer .config-ok")!;
    expect(ok.textContent).toBe("OK");
    ok.click();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("carries no theme control of its own", () => {
    const target = render({});
    expect(target.querySelector('[role="radiogroup"]')).toBeNull();
    expect(target.querySelectorAll("button")).toHaveLength(1);
  });
});
