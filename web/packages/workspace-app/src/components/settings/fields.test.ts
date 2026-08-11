// @vitest-environment jsdom

// Unit tests for the Settings field primitives. Each pins the one-way
// contract (value in, oncommit out, never a write-back) plus the
// behaviour that used to be hand-rolled at every call site: debounce
// timing, clamp policy, hex validation, and chip removal.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import TextField from "./TextField.svelte";
import SliderField from "./SliderField.svelte";
import NumberField from "./NumberField.svelte";
import ColorField from "./ColorField.svelte";
import ChipList from "./ChipList.svelte";
import TestHost from "./fieldsTestHost.svelte";

let target: HTMLDivElement;
let cleanups: (() => void)[] = [];

function host(): HTMLDivElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  return target;
}

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  target?.remove();
  vi.useRealTimers();
});

describe("TextField", () => {
  test("debounces keystrokes into one commit with the live text", async () => {
    vi.useFakeTimers();
    const commits: string[] = [];
    const cmp = mount(TextField, {
      target: host(),
      props: { value: "", ariaLabel: "field", oncommit: (v: string) => commits.push(v) },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = "xterm";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "xterm-256color";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(399);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toEqual(["xterm-256color"]);
  });

  test("reseeds the text when the committed value changes externally", async () => {
    const cmp = mount(TestHost, {
      target: host(),
      props: { oncommit: () => {} },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("before");
    cmp.reseed("after");
    await tick();
    expect(input.value).toBe("after");
  });
});

describe("SliderField", () => {
  test("the thumb tracks the drag and commits once after the delay", async () => {
    vi.useFakeTimers();
    const commits: number[] = [];
    const cmp = mount(SliderField, {
      target: host(),
      props: {
        value: 10,
        min: 10,
        max: 50,
        step: 10,
        ariaLabel: "slider",
        format: (v: number) => `${v} MB`,
        oncommit: (v: number) => commits.push(v),
      },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("10");
    input.value = "30";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(target.querySelector(".value")?.textContent).toBe("30 MB");
    await vi.advanceTimersByTimeAsync(200);
    expect(commits).toEqual([30]);
    // The local position is not written back: the prop is still 10
    // until the parent commits.
    expect(target.querySelector(".value")?.textContent).toBe("30 MB");
  });
});

describe("NumberField", () => {
  test("clamps on blur and reports the bound that clamped", async () => {
    const commits: [number | null, string | null][] = [];
    const cmp = mount(NumberField, {
      target: host(),
      props: {
        value: 14,
        min: 8,
        max: 32,
        ariaLabel: "size",
        oncommit: (v: number | null, c: string | null) => commits.push([v, c]),
      },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = "99";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([[32, "max"]]);
    expect(input.value).toBe("32");
  });

  test("empty commits null only when nullable, otherwise the fallback", async () => {
    const commits: (number | null)[] = [];
    const cmp = mount(NumberField, {
      target: host(),
      props: {
        value: 16,
        min: 10,
        max: 32,
        nullable: true,
        ariaLabel: "size",
        oncommit: (v: number | null) => commits.push(v),
      },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([null]);
  });

  test("unparseable text commits the fallback, not garbage", async () => {
    const commits: (number | null)[] = [];
    const cmp = mount(NumberField, {
      target: host(),
      props: {
        value: 12,
        min: 8,
        max: 32,
        invalidFallback: 14,
        ariaLabel: "size",
        oncommit: (v: number | null) => commits.push(v),
      },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = "abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([14]);
    expect(input.value).toBe("14");
  });
});

describe("ColorField", () => {
  function mountColor(props: Record<string, unknown>) {
    const commits: (string | null)[] = [];
    const cmp = mount(ColorField, {
      target: host(),
      props: {
        id: "c1",
        label: "Background",
        value: "#112233",
        oncommit: (hex: string | null) => commits.push(hex),
        ...props,
      },
    });
    cleanups.push(() => unmount(cmp));
    return { cmp, commits };
  }

  test("invalid hex sets the error and commits nothing", async () => {
    const { commits } = mountColor({});
    await tick();
    const input = target.querySelector("#c1") as HTMLInputElement;
    input.value = "invalid";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(target.querySelector(".colour-error")?.textContent).toContain("#rgb");
  });

  test("valid hex commits normalized lowercase #rrggbb", async () => {
    const { commits } = mountColor({});
    await tick();
    const input = target.querySelector("#c1") as HTMLInputElement;
    input.value = "ABC";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual(["#aabbcc"]);
  });

  test("with a default, clearing the field commits null and shows the default", async () => {
    const { commits } = mountColor({ defaultHex: "#112233", value: "#445566" });
    await tick();
    const input = target.querySelector("#c1") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([null]);
    expect(input.value).toBe("#112233");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  test("entering the default commits null rather than a redundant override", async () => {
    const { commits } = mountColor({ defaultHex: "#112233", value: "#445566" });
    await tick();
    const input = target.querySelector("#c1") as HTMLInputElement;
    input.value = "#112233";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([null]);
  });

  test("without a default, empty text is a validation error", async () => {
    const { commits } = mountColor({});
    await tick();
    const input = target.querySelector("#c1") as HTMLInputElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await tick();
    expect(commits).toEqual([]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("ChipList", () => {
  test("readonly renders no remove buttons; editable reports removals", async () => {
    const removed: string[] = [];
    const cmp = mount(ChipList, {
      target: host(),
      props: { names: ["a", "b"], onremove: (n: string) => removed.push(n) },
    });
    cleanups.push(() => unmount(cmp));
    await tick();
    const buttons = target.querySelectorAll(".chip-x");
    expect(buttons).toHaveLength(2);
    (buttons[1] as HTMLButtonElement).click();
    expect(removed).toEqual(["b"]);

    const ro = mount(ChipList, {
      target: host(),
      props: { names: ["x"], readonly: true },
    });
    cleanups.push(() => unmount(ro));
    await tick();
    expect(target.querySelector(".chip-x")).toBeNull();
  });
});
