import { describe, expect, it } from "vitest";
import { sessionDeckDraftKey } from "./model";

describe("sessionDeckDraftKey", () => {
  it("names both launcher drafts under the cloned-session prefix", () => {
    expect(sessionDeckDraftKey("contextual")).toBe("chan.command-launcher.v1:contextual");
    expect(sessionDeckDraftKey("computers")).toBe("chan.command-launcher.v1:computers");
  });
});
