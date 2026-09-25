// @vitest-environment jsdom
//
// A setting's on/off control is a pill: a label wrapping a native checkbox,
// checked while the setting is on, reporting each toggle, and disabled while
// its write is in flight. A choice among values is a group of pills wrapping
// native radios, the chosen one checked. The workspace's chan-reports switch
// is such a pill, held while it writes. (The pills' look is one block in
// SettingField's stylesheet, which jsdom does not apply.)

import { flushSync, mount, tick, unmount, type Component } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../../api/client";
import PillRadio from "./PillRadio.svelte";
import PillToggle from "./PillToggle.svelte";
import ReportsControl from "./workspace/ReportsControl.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function render<Props extends Record<string, any>>(component: Component<Props>, props: Props): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(component, { target, props }) as Record<string, unknown>);
  flushSync();
  return target;
}

describe("PillToggle", () => {
  test("is a label wrapping a checkbox, checked while the setting is on", () => {
    const off = render(PillToggle, { checked: false, label: "Strip on save", ontoggle: () => {} });
    const on = render(PillToggle, { checked: true, label: "Strip on save", ontoggle: () => {} });

    expect(off.querySelector<HTMLInputElement>("label.pill > input[type=checkbox]")!.checked).toBe(false);
    expect(on.querySelector<HTMLInputElement>("label.pill > input[type=checkbox]")!.checked).toBe(true);
    expect(on.querySelector("label.pill")!.textContent?.trim()).toBe("Strip on save");
  });

  test("reports each toggle", () => {
    const ontoggle = vi.fn();
    const target = render(PillToggle, { checked: false, label: "Strip on save", ontoggle });

    target.querySelector<HTMLInputElement>("input")!.click();

    expect(ontoggle).toHaveBeenCalledWith(true);
  });

  test("disables its checkbox while disabled", () => {
    const target = render(PillToggle, { checked: false, label: "x", disabled: true, ontoggle: () => {} });

    expect(target.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  });
});

describe("PillRadio", () => {
  const options = [
    { value: "standard", label: "Standard" },
    { value: "compact", label: "Compact" },
  ] as const;

  test("is a radio group of pills, the chosen one checked", () => {
    const target = render(PillRadio, {
      value: "standard",
      options,
      name: "spacing",
      ariaLabel: "Line spacing",
      onselect: () => {},
    });

    const group = target.querySelector('[role="radiogroup"][aria-label="Line spacing"]')!;
    const pills = [...group.querySelectorAll("label.pill")];
    expect(pills.map((pill) => [pill.textContent?.trim(), pill.querySelector("input")!.checked])).toEqual([
      ["Standard", true],
      ["Compact", false],
    ]);
    expect(group.querySelectorAll('label.pill > input[type="radio"][name="spacing"]')).toHaveLength(2);
    expect(group.querySelector('input[type="checkbox"]')).toBeNull();
  });

  test("reports the chosen value", () => {
    const onselect = vi.fn();
    const target = render(PillRadio, { value: "standard", options, name: "spacing", ariaLabel: "x", onselect });

    target.querySelector<HTMLInputElement>('input[value="compact"]')!.click();

    expect(onselect).toHaveBeenCalledWith("compact");
  });
});

describe("the chan-reports switch", () => {
  test("is a pill, held while it writes and on once the write lands", async () => {
    vi.spyOn(api, "reportsState").mockResolvedValue({ enabled: false });
    let land!: () => void;
    vi.spyOn(api, "reportsEnable").mockImplementation(
      () => new Promise((resolve) => (land = () => resolve({ enabled: true }))),
    );
    const target = render(ReportsControl, {});
    await vi.waitFor(() => expect(target.querySelector("label.pill > input[type=checkbox]")).not.toBeNull());
    const input = target.querySelector<HTMLInputElement>("label.pill > input")!;

    input.click();
    await tick();
    expect(target.querySelector<HTMLInputElement>("label.pill > input")!.disabled).toBe(true);

    land();
    await vi.waitFor(() => expect(target.querySelector("label.pill")!.classList.contains("on")).toBe(true));
    expect(target.querySelector<HTMLInputElement>("label.pill > input")!.disabled).toBe(false);
  });
});
