import { describe, expect, it } from "vitest";
import { createDeckDraft, parseDeckDraft } from "@chan/web-shared/command-deck";

// A restored draft must never carry an execution state. `pending` and
// `success` are backed by a promise that does not survive a hide, a reload, or
// a handover to another source, so restoring one paints an operation nothing
// will ever clear and the deck has no way forward. The host persists a real
// background failure as `error`, which does restore.
describe("parseDeckDraft operation restore", () => {
  const fallback = () => createDeckDraft("contextual");

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
