import { describe, expect, it } from "vitest";
import { createDeckDraft, parseDeckDraft } from "@chan/web-shared/command-deck";

// A restored draft must never carry promise-backed preparation or execution
// state. The promise does not survive a hide, reload, or handover to another
// source, so restoring it paints an operation nothing will ever clear. A real
// confirm or background failure does restore.
describe("parseDeckDraft operation restore", () => {
  const fallback = () => createDeckDraft("contextual");

  it("drops a persisted preparing operation", () => {
    const parsed = parseDeckDraft(
      {
        version: 1,
        visible: true,
        query: "",
        path: [],
        selectedId: null,
        scope: "tab",
        operation: { kind: "preparing", itemId: "window.close", title: "Close" },
        contextChanged: false,
      },
      fallback(),
    );
    expect(parsed.operation).toBeNull();
  });

  it("drops a persisted pending operation", () => {
    const parsed = parseDeckDraft(
      {
        version: 1,
        visible: true,
        query: "",
        path: [],
        selectedId: null,
        scope: "tab",
        operation: { kind: "pending", itemId: "tab.send-b", title: "Send tab to side B" },
        contextChanged: false,
      },
      fallback(),
    );
    expect(parsed.operation).toBeNull();
  });

  it("drops a persisted success operation", () => {
    const parsed = parseDeckDraft(
      {
        version: 1,
        visible: true,
        query: "",
        path: [],
        selectedId: null,
        scope: "tab",
        operation: { kind: "success", itemId: "tab.send-b", title: "Send tab to side B" },
        contextChanged: false,
      },
      fallback(),
    );
    expect(parsed.operation).toBeNull();
  });

  it("restores a persisted confirmation", () => {
    const parsed = parseDeckDraft(
      {
        version: 1,
        visible: true,
        query: "",
        path: ["windows", "local:w-1"],
        selectedId: "computers:close:local:w-1",
        scope: "computers",
        operation: {
          kind: "confirm",
          itemId: "computers:close:local:w-1",
          title: "Close Window 1?",
          message: "This window will close.",
          actionLabel: "Close",
          danger: true,
          selected: "cancel",
        },
        contextChanged: false,
      },
      fallback(),
    );
    expect(parsed.operation).toMatchObject({
      kind: "confirm",
      itemId: "computers:close:local:w-1",
      message: "This window will close.",
    });
  });

  it("restores a persisted error operation so a background failure survives", () => {
    const parsed = parseDeckDraft(
      {
        version: 1,
        visible: true,
        query: "",
        path: [],
        selectedId: null,
        scope: "tab",
        operation: {
          kind: "error",
          itemId: "tab.send-b",
          title: "Send tab to side B",
          message: "the invoking window did not acknowledge the command",
          selected: "back",
        },
        contextChanged: false,
      },
      fallback(),
    );
    expect(parsed.operation).toEqual({
      kind: "error",
      itemId: "tab.send-b",
      title: "Send tab to side B",
      message: "the invoking window did not acknowledge the command",
      selected: "back",
    });
  });
});
