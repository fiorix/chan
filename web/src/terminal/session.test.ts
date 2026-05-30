import { describe, expect, test } from "vitest";
import { terminalWsPath } from "./session";

describe("terminalWsPath", () => {
  test("omits session query fields for a fresh terminal", () => {
    expect(
      terminalWsPath({
        cols: 100,
        rows: 31,
        tabName: "Terminal",
      }),
    ).toBe("/api/terminal/ws?cols=100&rows=31&tab_name=Terminal");
  });

  test("adds session and since fields when reattaching", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "build log",
        sessionId: "term_abc",
        lastSeq: 42,
      }),
    ).toBe(
      "/api/terminal/ws?cols=80&rows=24&tab_name=build+log&session=term_abc&since=42",
    );
  });

  test("adds window id when provided", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "shell",
        windowId: "workspace-notes-7",
      }),
    ).toBe(
      "/api/terminal/ws?cols=80&rows=24&tab_name=shell&window_id=workspace-notes-7",
    );
  });

  test("reattach starts from zero when no sequence was persisted", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "shell",
        sessionId: "term_abc",
      }),
    ).toContain("&since=0");
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "shell",
        sessionId: "term_abc",
      }),
    ).not.toContain("agent_echo_since");
  });

  test("adds mcp_env off only for fresh opt-out sessions", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "plain shell",
        mcpEnv: false,
      }),
    ).toBe("/api/terminal/ws?cols=80&rows=24&tab_name=plain+shell&mcp_env=off");
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "reattach",
        sessionId: "term_abc",
        lastSeq: 1,
        mcpEnv: false,
      }),
    ).not.toContain("mcp_env");
  });

  test("adds cwd only for fresh terminal sessions", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "from here",
        cwd: "notes/work",
      }),
    ).toBe("/api/terminal/ws?cols=80&rows=24&tab_name=from+here&cwd=notes%2Fwork");
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "reattach",
        sessionId: "term_abc",
        cwd: "notes/work",
      }),
    ).not.toContain("cwd");
  });
});
