// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const apiMocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  read: vi.fn(),
  write: vi.fn(async (_path: string, _content: string) => ({})),
}));

vi.mock("../api/client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      createDraft: () => apiMocks.createDraft(),
      read: (path: string) => apiMocks.read(path),
      write: (path: string, content: string) => apiMocks.write(path, content),
    },
  };
});

import RichPrompt from "./RichPrompt.svelte";
import type { TerminalTab } from "../state/tabs.svelte";

const mounted: Array<Record<string, unknown>> = [];
const unhandledRejections: unknown[] = [];

function captureUnhandledRejection(event: PromiseRejectionEvent): void {
  unhandledRejections.push(event.reason);
  event.preventDefault();
}

beforeEach(() => {
  apiMocks.createDraft.mockReset();
  apiMocks.read.mockReset();
  apiMocks.write.mockClear();
  unhandledRejections.length = 0;
  window.addEventListener("unhandledrejection", captureUnhandledRejection);
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", captureUnhandledRejection);
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...overrides,
  } as TerminalTab;
}

function render(tab: TerminalTab): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(
    mount(RichPrompt, { target, props: { tab, focused: false } }) as Record<
      string,
      unknown
    >,
  );
  return target;
}

async function waitForElement(
  target: HTMLElement,
  selector: string,
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await tick();
    await Promise.resolve();
    const element = target.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  throw new Error(`timed out waiting for ${selector}`);
}

async function waitForEditor(
  target: HTMLElement,
  expectedContent: string,
): Promise<EditorView> {
  const content = await waitForElement(target, ".cm-content");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("expected a mounted CodeMirror editor");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await tick();
    await Promise.resolve();
    if (view.state.doc.toString() === expectedContent) return view;
  }
  throw new Error(`editor did not load ${JSON.stringify(expectedContent)}`);
}

async function flushUnhandledRejections(): Promise<void> {
  await tick();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Rich Prompt mount guard", () => {
  test("a create failure is visible and retry mounts the recovered draft", async () => {
    apiMocks.createDraft
      .mockRejectedValueOnce(new Error("forbidden"))
      .mockResolvedValueOnce({ path: ".Drafts/recovered/draft.md" });
    apiMocks.read.mockResolvedValue({ content: "recovered prompt" });

    const target = render(terminalTab());
    const alert = await waitForElement(target, ".rp-load-error");

    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(
      "Could not create Rich Prompt draft: forbidden",
    );
    expect(target.querySelector(".cm-content")).toBeNull();

    const retry = alert.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toBe("Retry");
    retry?.click();

    const view = await waitForEditor(target, "recovered prompt");
    expect(view.state.doc.toString()).toBe("recovered prompt");
    expect(target.querySelector(".rp-load-error")).toBeNull();
    expect(apiMocks.createDraft).toHaveBeenCalledTimes(2);
    expect(apiMocks.read).toHaveBeenCalledOnce();
    await flushUnhandledRejections();
    expect(unhandledRejections).toEqual([]);
  });

  test("a content-load failure is visible and retry reloads the same draft", async () => {
    apiMocks.read
      .mockRejectedValueOnce(new Error("draft unavailable"))
      .mockResolvedValueOnce({ content: "loaded on retry" });
    const tab = terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md" });

    const target = render(tab);
    const alert = await waitForElement(target, ".rp-load-error");

    expect(alert.textContent).toContain(
      "Could not load Rich Prompt draft: draft unavailable",
    );
    expect(target.querySelector(".cm-content")).toBeNull();

    alert.querySelector<HTMLButtonElement>("button")?.click();
    const view = await waitForEditor(target, "loaded on retry");

    expect(view.state.doc.toString()).toBe("loaded on retry");
    expect(apiMocks.createDraft).not.toHaveBeenCalled();
    expect(apiMocks.read).toHaveBeenCalledTimes(2);
    await flushUnhandledRejections();
    expect(unhandledRejections).toEqual([]);
  });
});
