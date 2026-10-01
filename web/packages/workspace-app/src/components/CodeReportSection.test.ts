// @vitest-environment jsdom
//
// The inspector's Code section, mounted with a report: the totals and the
// COCOMO estimate it shows, the language rows it previews and expands, and
// the language a row's button hands to its owner.

import { flushSync, type ComponentProps } from "svelte";
import { createClassComponent } from "svelte/legacy";
import { afterEach, describe, expect, test, vi } from "vitest";

import CodeReportSection from "./CodeReportSection.svelte";
import type { ReportPrefix } from "../api/types";
import { fmtDevs, fmtMonths } from "../state/format";

type Props = ComponentProps<typeof CodeReportSection>;

// A report of `languages` languages, the first with the most code.
function reportOf(languages: number): ReportPrefix {
  return {
    totals: { files: 1234, code: 56789, comments: 2345, blanks: 1111, complexity: 4321 },
    by_language: Array.from({ length: languages }, (_, i) => ({
      name: `Lang${i + 1}`,
      files: i + 1,
      code: (languages - i) * 1000,
      comments: 0,
      blanks: 0,
      complexity: 0,
    })),
    cocomo: {
      model: "organic",
      effort_person_months: 12.4,
      schedule_months: 3.14,
      developers: 2.5,
      estimated_cost_usd: 1000,
    },
  };
}

const mounted: Array<{ $destroy(): void }> = [];
let target: HTMLElement;

function render(props: Partial<Props> = {}) {
  target = document.body.appendChild(document.createElement("div"));
  const section = createClassComponent({
    component: CodeReportSection,
    target,
    props: { report: reportOf(7), onLanguageClick: () => {}, ...props },
  });
  mounted.push(section);
  flushSync();
  return section;
}

afterEach(() => {
  for (const section of mounted.splice(0)) section.$destroy();
  document.body.replaceChildren();
});

function rows(): string[] {
  return [...target.querySelectorAll("button.lang-name")].map((b) => b.textContent ?? "");
}

function toggle(): HTMLButtonElement | null {
  return target.querySelector<HTMLButtonElement>("button.see-more");
}

function values(scope: string): string[] {
  return [...target.querySelectorAll(`${scope} .v`)].map((v) => v.textContent ?? "");
}

describe("CodeReportSection", () => {
  test("shows the report's totals and the COCOMO estimate as the formatters give it", () => {
    render();
    expect(target.querySelector("section.refs > h4")?.textContent).toBe("Code");
    expect(values("section.refs > .meta-grid")).toEqual([
      "1234",
      (56789).toLocaleString(),
      (2345).toLocaleString(),
      (1111).toLocaleString(),
      (4321).toLocaleString(),
    ]);
    expect(target.querySelector(".cocomo-title")?.textContent).toBe("COCOMO (organic)");
    expect(values(".cocomo")).toEqual([fmtMonths(12.4), fmtMonths(3.14), fmtDevs(2.5)]);
  });

  test("previews five of seven languages and expands to all of them and back", () => {
    render();
    expect(rows()).toEqual(["Lang1", "Lang2", "Lang3", "Lang4", "Lang5"]);
    expect(target.querySelector(".lang-row")?.textContent).toContain("1 file");
    expect(target.querySelectorAll(".lang-row")[1]?.textContent).toContain("2 files");
    expect(toggle()?.textContent).toBe("+2 more");

    toggle()!.click();
    flushSync();
    expect(rows()).toHaveLength(7);
    expect(toggle()?.textContent).toBe("show fewer");

    toggle()!.click();
    flushSync();
    expect(rows()).toHaveLength(5);
    expect(toggle()?.textContent).toBe("+2 more");
  });

  test("a report of five languages or fewer shows them all and no toggle", () => {
    render({ report: reportOf(5) });
    expect(rows()).toHaveLength(5);
    expect(toggle()).toBeNull();
  });

  test("a language's button hands its name to the owner", () => {
    const onLanguageClick = vi.fn();
    render({ onLanguageClick });
    target.querySelectorAll<HTMLButtonElement>("button.lang-name")[2].click();
    expect(onLanguageClick).toHaveBeenCalledTimes(1);
    expect(onLanguageClick).toHaveBeenCalledWith("Lang3");
  });

  test("a new report shows the preview again", () => {
    const section = render();
    toggle()!.click();
    flushSync();
    expect(rows()).toHaveLength(7);

    section.$set({ report: reportOf(8) });
    flushSync();
    expect(rows(), "a new report shows the preview again").toHaveLength(5);
    expect(toggle()?.textContent).toBe("+3 more");
  });
});
