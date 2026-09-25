// @vitest-environment jsdom
//
// The per-surface body-theme row in Settings: one radio group per surface,
// whose choice pins that surface to Light or Dark or lets it inherit the app
// theme. The field is mounted with a commit that runs its persist step, and
// the config write is stubbed; the assertions read the live surface themes
// and what the commit asked the settings buffer to become.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const writes = vi.hoisted(() => ({ patches: [] as unknown[] }));

vi.mock("../../api/preferenceWrite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/preferenceWrite")>();
  return {
    ...actual,
    updateGlobalConfigSerial: vi.fn(async (patch: () => unknown) => {
      writes.patches.push(patch());
    }),
  };
});

import SurfaceThemeField from "./SurfaceThemeField.svelte";
import type { HybridSurfaceKind, Preferences } from "../../api/types";
import { hybridSurfaceThemes } from "../../state/store.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  for (const kind of Object.keys(hybridSurfaceThemes) as HybridSurfaceKind[]) delete hybridSurfaceThemes[kind];
  writes.patches = [];
});

function render(kind: HybridSurfaceKind, themes: Preferences["hybrid_surface_themes"] = {}) {
  const prefs = { hybrid_surface_themes: themes } as Preferences;
  const buffers: Preferences[] = [];
  const commit = vi.fn(async (mutate: (p: Preferences) => Preferences, persist?: () => Promise<unknown>) => {
    buffers.push(mutate(prefs));
    await persist?.();
    return "saved" as const;
  });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(SurfaceThemeField, { target, props: { kind, prefs, commit } }));
  flushSync();
  const choose = async (label: string) => {
    const pill = [...target.querySelectorAll<HTMLLabelElement>("label.pill")].find(
      (l) => l.textContent?.trim() === label,
    );
    pill!.querySelector("input")!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { target, commit, buffers, choose };
}

describe("the surface theme row", () => {
  test("is one radio group per surface, showing the current choice", () => {
    const { target } = render("graph", { graph: "dark" });
    const group = target.querySelector('[role="radiogroup"]')!;
    const inputs = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(inputs.map((i) => [i.name, i.value])).toEqual([
      ["settings-surface-theme-graph", "inherit"],
      ["settings-surface-theme-graph", "light"],
      ["settings-surface-theme-graph", "dark"],
    ]);
    expect(inputs.find((i) => i.checked)?.value).toBe("dark");
  });

  test("Dark pins that surface only, in the buffer and live, and persists the table", async () => {
    hybridSurfaceThemes.editor = "light";
    const { choose, buffers } = render("graph");
    await choose("Dark");

    expect(buffers.at(-1)?.hybrid_surface_themes).toEqual({ graph: "dark" });
    expect({ ...hybridSurfaceThemes }).toEqual({ editor: "light", graph: "dark" });
    expect(writes.patches.at(-1)).toEqual({ hybrid_surface_themes: { editor: "light", graph: "dark" } });
  });

  test("Inherit drops the surface's pin", async () => {
    hybridSurfaceThemes.graph = "dark";
    const { choose, buffers } = render("graph", { graph: "dark" });
    await choose("Inherit");

    expect(buffers.at(-1)?.hybrid_surface_themes).toEqual({});
    expect(hybridSurfaceThemes.graph).toBeUndefined();
    expect(writes.patches.at(-1)).toEqual({ hybrid_surface_themes: {} });
  });
});
