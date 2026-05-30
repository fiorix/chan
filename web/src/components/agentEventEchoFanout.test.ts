import { describe, expect, test } from "vitest";
import terminal from "./TerminalTab.svelte?raw";

describe("agent inbox delivery", () => {
  test("terminal UI does not own agent-event echo replay", () => {
    expect(terminal).not.toContain("agent_event_echo");
    expect(terminal).not.toContain("decodeAgentEventEcho");
    expect(terminal).not.toContain("lastAgentEchoSeq");
  });

  test("typed user input still uses the broadcast fan-out path", () => {
    expect(terminal).toMatch(
      /function sendUserInput\(data: string\): void \{[\s\S]*?sendInput\(data\);[\s\S]*?broadcastTerminalInput\(tab, data\);/,
    );
  });
});
