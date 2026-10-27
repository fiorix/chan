import { describe, expect, it } from "vitest";
import { SESSION_DECK_DRAFT_KEY } from "./model";

describe("SESSION_DECK_DRAFT_KEY", () => {
  it("names the launcher draft under the cloned-session prefix", () => {
    expect(SESSION_DECK_DRAFT_KEY).toBe("chan.command-launcher.v1:contextual");
  });
});
