import { describe, expect, test } from "vitest";
import app from "./App.svelte?raw";

// Comma opens Settings. The focused-pane flip remains a separate command and
// must not be wired to the comma key path.

describe("Cmd+, opens Settings", () => {
  test("the flip action stays off the comma key path", () => {
    expect(app).toMatch(
      /const commandName = name === "app\.settings\.toggle" \? "app\.pane\.flip" : name;/,
    );
  });
});
