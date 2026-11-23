import { describe, expect, test } from "vitest";
import { sessionRunsMuse } from "./drawnWraps";

describe("sessionRunsMuse", () => {
  test.each([
    ["a tab the server derived Muse for", "muse", null, true],
    ["Muse's binary in front of a shell", undefined, "muse-bin-1.4.24", true],
    ["Muse's launcher in front", undefined, "muse", true],
    ["a tab spawned as Muse whose shell stays in front", "muse", "bash", true],
    ["a shell", undefined, "bash", false],
    ["another agent", "claude", "claude", false],
    ["a name with muse inside a word", undefined, "amuse", false],
    ["no reading at all", undefined, null, false],
  ] as const)("%s", (_, agent, command, runs) => {
    expect(sessionRunsMuse(agent, command)).toBe(runs);
  });
});
