import { describe, expect, test } from "vitest";

import { agentForCommand, agentForMember } from "./teamDialog.svelte";

describe("agentForCommand (loose derivation)", () => {
  test("recognizes the bare agent name", () => {
    expect(agentForCommand("agy")).toBe("agy");
    expect(agentForCommand("claude")).toBe("claude");
    expect(agentForCommand("codex")).toBe("codex");
    expect(agentForCommand("gemini")).toBe("gemini");
    expect(agentForCommand("kimi")).toBe("kimi");
    expect(agentForCommand("opencode")).toBe("opencode");
  });

  test("matches past the first token and through a path/wrapper", () => {
    expect(agentForCommand("claude --resume")).toBe("claude");
    expect(agentForCommand("/usr/local/bin/codex-cli")).toBe("codex");
    expect(agentForCommand("my-claude.sh --flag")).toBe("claude");
    expect(agentForCommand("env FOO=1 gemini chat")).toBe("gemini");
    expect(agentForCommand("/usr/local/bin/opencode-ai")).toBe("opencode");
    expect(agentForCommand("/home/fiorix/.kimi-code/bin/kimi")).toBe("kimi");
    expect(agentForCommand("kimi --yolo")).toBe("kimi");
    expect(agentForCommand("/home/fiorix/.local/bin/agy")).toBe("agy");
    expect(agentForCommand("agy --continue")).toBe("agy");
  });

  test("is case-insensitive", () => {
    expect(agentForCommand("CLAUDE")).toBe("claude");
    expect(agentForCommand("OPENCODE")).toBe("opencode");
    expect(agentForCommand("KIMI")).toBe("kimi");
    expect(agentForCommand("AGY")).toBe("agy");
  });

  test("word boundaries keep near-misses from matching", () => {
    expect(agentForCommand("claudette")).toBe("none");
    expect(agentForCommand("codexterous")).toBe("none");
    expect(agentForCommand("myopencode")).toBe("none");
    expect(agentForCommand("opencoded")).toBe("none");
    expect(agentForCommand("kimiko")).toBe("none");
    expect(agentForCommand("stagy")).toBe("none");
    expect(agentForCommand("agyle")).toBe("none");
  });

  test("an unrecognized command falls back to none (a shell)", () => {
    expect(agentForCommand("bash")).toBe("none");
    expect(agentForCommand("zsh -l")).toBe("none");
    expect(agentForCommand("")).toBe("none");
  });
});

describe("agentForMember (CHAN_AGENT override)", () => {
  test("CHAN_AGENT wins over the command derivation", () => {
    // command sniffs as codex, env forces claude
    expect(agentForMember("codex", "CHAN_AGENT=claude")).toBe("claude");
    // an unorthodox launcher the command can't reveal
    expect(agentForMember("./run-my-agent.sh", "CHAN_AGENT=gemini")).toBe("gemini");
    expect(agentForMember("claude", "CHAN_AGENT=opencode")).toBe("opencode");
    expect(agentForMember("bash", "CHAN_AGENT=kimi")).toBe("kimi");
    expect(agentForMember("kimi", "CHAN_AGENT=codex")).toBe("codex");
    expect(agentForMember("bash", "CHAN_AGENT=agy")).toBe("agy");
    expect(agentForMember("agy", "CHAN_AGENT=claude")).toBe("claude");
  });

  test("CHAN_AGENT=none / shell forces a shell despite an agent command", () => {
    expect(agentForMember("claude", "CHAN_AGENT=none")).toBe("none");
    expect(agentForMember("claude", "CHAN_AGENT=shell")).toBe("none");
  });

  test("CHAN_AGENT is found among other env lines and tolerates whitespace", () => {
    expect(agentForMember("bash", "FOO=bar\nCHAN_AGENT = codex\nBAZ=1")).toBe("codex");
  });

  test("an unrecognized CHAN_AGENT value falls through to the command", () => {
    expect(agentForMember("claude", "CHAN_AGENT=banana")).toBe("claude");
    expect(agentForMember("bash", "CHAN_AGENT=banana")).toBe("none");
  });

  test("with no CHAN_AGENT it is exactly the command derivation", () => {
    expect(agentForMember("claude --resume", "")).toBe("claude");
    expect(agentForMember("bash", "FOO=bar")).toBe("none");
  });
});
