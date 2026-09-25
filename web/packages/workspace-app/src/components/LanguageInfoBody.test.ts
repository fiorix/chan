// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import inspector from "./InspectorBody.svelte?raw";
import panel from "./GraphPanel.svelte?raw";
import type { LanguageGraphDetail } from "../api/types";
import LanguageInfoBody from "./LanguageInfoBody.svelte";

// Language-node inspector detail: COCOMO summary + complete ranked
// directory list with five-at-a-time "Load more" paging. The api
// client is mocked; these tests pin the fetch shape, the paging
// behaviour, and the directory-row routing. `?raw` pins lock the
// InspectorBody / GraphPanel wiring at source level.

const languageGraph = vi.fn();

vi.mock("../api/client", () => ({
  api: {
    languageGraph: (opts: unknown) => languageGraph(opts),
  },
}));

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  languageGraph.mockReset();
});

function detail(dirCount: number): LanguageGraphDetail {
  const directories = Array.from({ length: dirCount }, (_, i) => ({
    path: `src/d${i + 1}`,
    label: `d${i + 1}`,
    rank: i + 1,
    files: dirCount - i,
    code: (dirCount - i) * 100,
  }));
  return {
    language: "Rust",
    files: 10,
    code: 540,
    cocomo: {
      model: "basic-organic",
      effort_person_months: 1.5,
      schedule_months: 2.5,
      developers: 0.6,
      estimated_cost_usd: 28800,
    },
    directories,
  };
}

function render(
  dirCount: number,
  props: Record<string, unknown> = {},
): HTMLElement {
  languageGraph.mockResolvedValue({
    max_depth: dirCount,
    nodes: [],
    edges: [],
    detail: detail(dirCount),
  });
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(LanguageInfoBody, {
    target,
    props: { language: "Rust", label: "Rust", files: 10, code: 540, ...props } as any,
  });
  mounted.push(component);
  return target;
}

async function settled(target: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    expect(target.querySelector(".cocomo")).not.toBeNull();
  });
}

function dirLabels(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".dir-row .dir-name, .dir-row .dir-name-static")].map(
    (el) => el.textContent ?? "",
  );
}

describe("LanguageInfoBody detail fetch", () => {
  test("fetches the language detail with no depth limit", async () => {
    const target = render(3);
    await settled(target);
    // The inspector must get the complete directory list regardless
    // of the rendered graph's depth, so the request carries only the
    // language filter and never a depth cutoff.
    expect(languageGraph).toHaveBeenCalledWith({ language: "Rust" });
    expect(languageGraph).toHaveBeenCalledTimes(1);
  });

  test("shows a fetch failure instead of stale detail", async () => {
    languageGraph.mockRejectedValue(new Error("boom"));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(LanguageInfoBody, {
        target,
        props: { language: "Rust", label: "Rust" } as any,
      }),
    );
    await vi.waitFor(() => {
      expect(target.querySelector(".detail-error")).not.toBeNull();
    });
    expect(target.querySelector(".cocomo")).toBeNull();
  });
});

describe("LanguageInfoBody COCOMO rendering", () => {
  test("renders model, effort, schedule, developers, and cost", async () => {
    const target = render(0);
    await settled(target);
    const text = target.querySelector(".cocomo")!.textContent ?? "";
    expect(text).toContain("COCOMO (basic-organic)");
    expect(text).toContain("1.5 mo");
    expect(text).toContain("2.5 mo");
    expect(text).toContain("0.6");
    expect(text).toContain("$28,800");
  });

  test("empty directory data renders COCOMO but no list or pager", async () => {
    const target = render(0);
    await settled(target);
    expect(target.querySelector(".dirs")).toBeNull();
    expect(target.querySelector(".load-more")).toBeNull();
  });
});

describe("LanguageInfoBody directory paging", () => {
  test("fewer than five directories renders all without a pager", async () => {
    const target = render(3);
    await settled(target);
    expect(dirLabels(target)).toEqual(["d1", "d2", "d3"]);
    expect(target.querySelector(".load-more")).toBeNull();
  });

  test("exactly five directories renders all without a pager", async () => {
    const target = render(5);
    await settled(target);
    expect(dirLabels(target)).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(target.querySelector(".load-more")).toBeNull();
  });

  test("six directories pages five plus one without duplicates", async () => {
    const target = render(6);
    await settled(target);
    expect(dirLabels(target)).toEqual(["d1", "d2", "d3", "d4", "d5"]);

    target.querySelector<HTMLButtonElement>(".load-more")!.click();
    await tick();

    expect(dirLabels(target)).toEqual(["d1", "d2", "d3", "d4", "d5", "d6"]);
    expect(target.querySelector(".load-more")).toBeNull();
  });

  test("repeated Load more appends five rows at a time in rank order", async () => {
    const target = render(12);
    await settled(target);
    expect(dirLabels(target)).toHaveLength(5);

    target.querySelector<HTMLButtonElement>(".load-more")!.click();
    await tick();
    expect(dirLabels(target)).toHaveLength(10);

    target.querySelector<HTMLButtonElement>(".load-more")!.click();
    await tick();

    expect(dirLabels(target)).toEqual(
      Array.from({ length: 12 }, (_, i) => `d${i + 1}`),
    );
    expect(target.querySelector(".load-more")).toBeNull();
  });

  test("each row carries its directory file and SLOC stats", async () => {
    const target = render(2);
    await settled(target);
    const rows = [...target.querySelectorAll(".dir-row")];
    expect(rows[0].textContent).toContain("2 files");
    expect(rows[0].textContent).toContain("200 SLOC");
    expect(rows[1].textContent).toContain("1 file");
    expect(rows[1].textContent).toContain("100 SLOC");
  });
});

describe("LanguageInfoBody directory routing", () => {
  test("clicking a row calls onOpenDirectory with the directory path", async () => {
    const onOpenDirectory = vi.fn();
    const target = render(3, { onOpenDirectory });
    await settled(target);

    const buttons = target.querySelectorAll<HTMLButtonElement>(".dir-row .dir-name");
    buttons[1].click();
    expect(onOpenDirectory).toHaveBeenCalledWith("src/d2");
    expect(onOpenDirectory).toHaveBeenCalledTimes(1);
  });

  test("each row button exposes the full path in title and accessible name", async () => {
    const target = render(2, { onOpenDirectory: vi.fn() });
    await settled(target);

    // The visible text stays the basename; the full directory path
    // goes to the tooltip and the accessible name.
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".dir-row .dir-name")];
    expect(buttons).toHaveLength(2);
    for (const [i, button] of buttons.entries()) {
      expect(button.textContent).toBe(`d${i + 1}`);
      expect(button.title).toBe(`src/d${i + 1}`);
      expect(button.getAttribute("aria-label")).toBe(`src/d${i + 1}`);
    }
  });

  test("without onOpenDirectory the rows render as plain text", async () => {
    const target = render(2);
    await settled(target);
    expect(target.querySelector(".dir-row .dir-name")).toBeNull();
    expect(target.querySelectorAll(".dir-row .dir-name-static")).toHaveLength(2);
  });
});

describe("language detail wiring", () => {
  test("InspectorBody forwards onOpenDirectory to LanguageInfoBody", () => {
    expect(inspector).toMatch(
      /<LanguageInfoBody[\s\S]*?\{onSetAsScope\}[\s\S]*?\{onOpenDirectory\}/,
    );
  });

  test("GraphPanel routes directory rows through the directory graph-from-here", () => {
    expect(panel).toMatch(/onOpenDirectory=\{[\s\S]*?graphFromHere\(path, true\)/);
  });
});
