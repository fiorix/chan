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
