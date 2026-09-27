// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import StyleToolbar from "./StyleToolbar.svelte";
import type Wysiwyg from "../editor/Wysiwyg.svelte";
import type { BlockKind } from "../editor/commands/format";

type MockFn = ReturnType<typeof vi.fn>;

type FakeWysiwyg = {
  isActive: (name: string) => boolean;
  currentBlockKind: () => BlockKind;
  setBlockKind: MockFn;
  toggleBold: MockFn;
  toggleItalic: MockFn;
  toggleStrike: MockFn;
  toggleInlineCode: MockFn;
  toggleLink: MockFn;
  toggleBulletList: MockFn;
  toggleOrderedList: MockFn;
  toggleTaskList: MockFn;
  insertHorizontalRule: MockFn;
  insertImage: MockFn;
};

const mounted: Array<Record<string, any>> = [];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function fakeWysiwyg(active: string[] = [], block: BlockKind = "normal"): FakeWysiwyg {
  const activeSet = new Set(active);
  return {
    isActive: (name) => activeSet.has(name),
    currentBlockKind: () => block,
    setBlockKind: vi.fn(),
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleStrike: vi.fn(),
    toggleInlineCode: vi.fn(),
    toggleLink: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleTaskList: vi.fn(),
    insertHorizontalRule: vi.fn(),
    insertImage: vi.fn(),
  };
}

function asWysiwyg(wysiwyg: FakeWysiwyg): Wysiwyg {
  return wysiwyg as unknown as Wysiwyg;
}

async function renderToolbar(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const wysiwyg = (props.wysiwyg as FakeWysiwyg | undefined) ?? fakeWysiwyg();
  const selVer = typeof props.selVer === "number" ? props.selVer : 1;
  const component = mount(StyleToolbar, {
    target,
    props: { ...props, wysiwyg: asWysiwyg(wysiwyg), selVer },
  });
  mounted.push(component);
  await tick();
  const toolbar = target.querySelector<HTMLElement>("[role='toolbar']");
  if (!toolbar) throw new Error("toolbar not mounted");
  const expandZone = target.querySelector<HTMLElement>(".expand-zone");
  if (!expandZone) throw new Error("expand zone not mounted");
  expandZone.dispatchEvent(new MouseEvent("mouseenter"));
  await tick();
  return { target, toolbar, wysiwyg };
}

function button(target: ParentNode, name: string): HTMLButtonElement {
  const el = target.querySelector<HTMLButtonElement>(`button[aria-label='${name}']`);
  if (!el) throw new Error(`button not found: ${name}`);
  return el;
}

describe("StyleToolbar", () => {
  test.each(["source", "wysiwyg"] as const)("idle visibility in %s mode", async (mode) => {
    vi.useFakeTimers();
    const target = document.createElement("div");
    document.body.append(target);
    const onModeToggle = vi.fn();
    mounted.push(mount(StyleToolbar, {
      target,
      props: { wysiwyg: undefined, selVer: 1, mode, disabled: mode === "source", onModeToggle },
    }));
    await tick();
    const toolbar = target.querySelector<HTMLElement>("[role='toolbar']")!;
    expect(toolbar.classList.contains("hidden")).toBe(false);
    expect(target.querySelector(".fbtn-row")).toBeNull();
    await vi.advanceTimersByTimeAsync(3100);
    await tick();
    expect(toolbar.classList.contains("hidden")).toBe(mode === "wysiwyg");
    if (mode === "source") {
      button(target, "show rendered").click();
      expect(onModeToggle).toHaveBeenCalledWith("wysiwyg");
    }
  });

  test("file editor variant exposes and wires every formatting control", async () => {
    const { target, toolbar, wysiwyg } = await renderToolbar();

    expect(toolbar.classList.contains("floating")).toBe(true);
    expect(toolbar.classList.contains("inflow")).toBe(false);
    expect(target.querySelector(".fbtn-row")).not.toBeNull();

    const select = target.querySelector<HTMLSelectElement>("select.block-kind");
    expect(select).not.toBeNull();
    select!.value = "h2";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(wysiwyg.setBlockKind).toHaveBeenCalledWith("h2");

    const controls: Array<[string, MockFn]> = [
      ["bold", wysiwyg.toggleBold],
      ["italic", wysiwyg.toggleItalic],
      ["strikethrough", wysiwyg.toggleStrike],
      ["inline code", wysiwyg.toggleInlineCode],
      ["toggle link", wysiwyg.toggleLink],
      ["bullet list", wysiwyg.toggleBulletList],
      ["ordered list", wysiwyg.toggleOrderedList],
      ["task list", wysiwyg.toggleTaskList],
      ["insert horizontal rule", wysiwyg.insertHorizontalRule],
      ["insert image", wysiwyg.insertImage],
    ];

    for (const [label, action] of controls) {
      button(target, label).click();
      expect(action).toHaveBeenCalledTimes(1);
    }
  });

  test("prompt variant shares the control styling contract without image insertion", async () => {
    const { target, toolbar } = await renderToolbar({ showImage: false });

    expect(toolbar.classList.contains("floating")).toBe(true);
    expect(target.querySelector(".fbtn-row")).not.toBeNull();
    expect(button(target, "bold").classList.contains("fbtn")).toBe(true);
    expect(button(target, "toggle link").classList.contains("fbtn")).toBe(true);
    expect(target.querySelector("button[aria-label='insert image']")).toBeNull();

    const fileControlClasses = Array.from(button(target, "bold").classList).sort();
    const promptControlClasses = Array.from(button(target, "toggle link").classList).sort();
    expect(promptControlClasses).toEqual(fileControlClasses);
  });

  test("disabled state gates formatting controls but leaves mode toggle available", async () => {
    const onModeToggle = vi.fn();
    const { target, toolbar } = await renderToolbar({
      disabled: true,
      mode: "source",
      onModeToggle,
    });

    expect(toolbar.classList.contains("disabled")).toBe(true);
    expect(button(target, "bold").disabled).toBe(true);
    expect(target.querySelector<HTMLSelectElement>("select.block-kind")?.disabled).toBe(true);

    const mode = button(target, "show rendered");
    expect(mode.disabled).toBe(false);
    mode.click();
    expect(onModeToggle).toHaveBeenCalledWith("wysiwyg");
  });

  test("active marks render selected state", async () => {
    const wysiwyg = fakeWysiwyg(["bold", "link", "taskList"], "quote");
    const { target } = await renderToolbar({ wysiwyg, selVer: 2 });

    expect(button(target, "bold").classList.contains("on")).toBe(true);
    expect(button(target, "toggle link").classList.contains("on")).toBe(true);
    expect(button(target, "task list").classList.contains("on")).toBe(true);
    expect(target.querySelector<HTMLSelectElement>("select.block-kind")?.value).toBe("quote");
  });

  test("the formatting pill opens the row by focus and preserves editor mouse focus", async () => {
    const target = document.createElement("div");
    const editor = document.createElement("textarea");
    document.body.append(editor, target);
    const component = mount(StyleToolbar, {
      target,
      props: { wysiwyg: asWysiwyg(fakeWysiwyg()), selVer: 1 },
    });
    mounted.push(component);
    await tick();
    expect(target.querySelector(".fbtn-row")).toBeNull();
    const pill = target.querySelector<HTMLElement>(".pill")!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("type")).toBe("button");
    expect(pill.getAttribute("aria-label")).toBe("formatting");
    expect(pill.hasAttribute("aria-hidden")).toBe(false);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(pill.tabIndex).toBe(0);

    pill.focus();
    expect(document.activeElement).toBe(pill);
    await tick();
    expect(target.querySelector(".fbtn-row")).not.toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    button(target, "bold").focus();
    expect(document.activeElement).toBe(button(target, "bold"));

    editor.focus();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    pill.dispatchEvent(press);
    // jsdom does not transfer focus on mousedown; cancellation is the
    // browser contract that keeps the editor's selection available.
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor);
  });
});
