// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: "<svg></svg>" })),
}));

vi.mock("mermaid", () => ({ default: mermaid }));

import {
  renderMermaid,
  renderMermaidForClipboard,
} from "./mermaid_render";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Mermaid clipboard rendering", () => {
  test("the visible face keeps HTML labels", async () => {
    await renderMermaid("flowchart TD\n  A --> B", false);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ htmlLabels: true }),
    );
  });

  test("the copy-only face uses canvas-safe pure SVG labels", async () => {
    await renderMermaidForClipboard("flowchart TD\n  A --> B", false);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ htmlLabels: false }),
    );
  });
});

function holdNextRender() {
  let resolve!: (value: { svg: string }) => void;
  let reject!: (error: Error) => void;
  let started!: () => void;
  const pending = new Promise<{ svg: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const ready = new Promise<void>((res) => { started = res; });
  mermaid.render.mockImplementationOnce(() => {
    started();
    return pending;
  });
  return { ready, resolve, reject };
}

describe("Mermaid render sequencing", () => {
  test("serializes theme and label settings until the prior render settles", async () => {
    const held = holdNextRender();
    const first = renderMermaid("flowchart TD\n  A --> B", true);
    const second = renderMermaidForClipboard("flowchart TD\n  C --> D", false);
    try {
      await held.ready;
      await Promise.resolve();
      expect(mermaid.initialize).toHaveBeenCalledTimes(1);
      expect(mermaid.render).toHaveBeenCalledTimes(1);
      expect(mermaid.initialize).toHaveBeenNthCalledWith(1, {
        startOnLoad: false, securityLevel: "strict", theme: "dark", htmlLabels: true,
      });
      held.resolve({ svg: "<svg>first</svg>" });
      expect(await first).toEqual({ ok: true, svg: "<svg>first</svg>" });
      expect(await second).toEqual({ ok: true, svg: "<svg></svg>" });
      expect(mermaid.initialize).toHaveBeenCalledTimes(2);
      expect(mermaid.initialize).toHaveBeenNthCalledWith(2, {
        startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false,
      });
      expect(mermaid.render).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve({ svg: "<svg>first</svg>" });
      await Promise.allSettled([first, second]);
    }
  });

  test("runs the next render after the prior render rejects", async () => {
    const held = holdNextRender();
    const first = renderMermaid("flowchart TD\n  A --> B", true);
    const second = renderMermaidForClipboard("flowchart TD\n  C --> D", false);
    try {
      await held.ready;
      held.reject(new Error("render failed"));
      expect(await first).toMatchObject({ ok: false, error: "render failed" });
      expect(await second).toEqual({ ok: true, svg: "<svg></svg>" });
      expect(mermaid.render).toHaveBeenCalledTimes(2);
      expect(mermaid.initialize).toHaveBeenLastCalledWith({
        startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false,
      });
    } finally {
      held.resolve({ svg: "<svg>first</svg>" });
      await Promise.allSettled([first, second]);
    }
  });
});
