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

  test("reattach always requests the full ring (since=0)", () => {
    // `since` is the CONSTANT 0, not a byte cursor: a reattach always
    // feeds a fresh empty xterm, and explicit 0 (vs absent) makes the
    // server report ring-overflow loss via missed_bytes.
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "build log",
        sessionId: "term_abc",
      }),
    ).toBe(
      "/api/terminal/ws?cols=80&rows=24&tab_name=build+log&session=term_abc&since=0",
    );
  });

  test("resumes from a cached byte cursor + generation when provided", () => {
    // A valid scrollback-snapshot cache hit sends its cursor + generation; the
    // server replays only the delta past it, and honors it only on a matching
    // generation.
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "build log",
        sessionId: "term_abc",
        since: 1500,
        generation: 4,
      }),
    ).toBe(
      "/api/terminal/ws?cols=80&rows=24&tab_name=build+log&session=term_abc&since=1500&generation=4",
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

  test("adds pane, side, and tab ids when provided", () => {
    // The complete SPA attachment lets `cs terminal list` trace the session
    // through its window, Hybrid, side, and tab.
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "shell",
        paneId: "pane-7",
        side: "b",
        tabId: "tab-3",
      }),
    ).toBe(
      "/api/terminal/ws?cols=80&rows=24&tab_name=shell&pane_id=pane-7&side=b&tab_id=tab-3",
    );
    // Blank/absent ids never hit the wire.
    expect(
      terminalWsPath({ cols: 80, rows: 24, tabName: "shell", paneId: "  " }),
    ).not.toContain("pane_id");
  });

  test("never emits a per-terminal mcp_env override (now a global setting)", () => {
    // The SPA no longer forces `?mcp_env=`; injection is governed by
    // the global `terminal.mcp_env` server config. Neither a fresh
    // spawn nor a reattach should carry the param.
    expect(
      terminalWsPath({ cols: 80, rows: 24, tabName: "plain shell" }),
    ).not.toContain("mcp_env");
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "reattach",
        sessionId: "term_abc",
      }),
    ).not.toContain("mcp_env");
  });

  test("adds tab_group only for non-default groups", () => {
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "agent",
        tabGroup: "foobar",
      }),
    ).toBe("/api/terminal/ws?cols=80&rows=24&tab_name=agent&tab_group=foobar");
    // The default group is implicit; never on the wire.
    expect(
      terminalWsPath({
        cols: 80,
        rows: 24,
        tabName: "plain",
        tabGroup: "default",
      }),
    ).not.toContain("tab_group");
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

  test("adds the shell profile only for fresh terminal sessions", () => {
    const fresh = terminalWsPath({
      cols: 80,
      rows: 24,
      tabName: "git bash",
      profile: "git-bash",
    });
    expect(new URL(fresh, "http://chan.test").searchParams.get("profile")).toBe("git-bash");

    // A reattach adopts the live PTY's shell; it cannot switch it, and the
    // server ignores the param on that path anyway.
    const reattach = terminalWsPath({
      cols: 80,
      rows: 24,
      tabName: "git bash",
      sessionId: "term_abc",
      profile: "git-bash",
    });
    expect(reattach).not.toContain("profile");

    // Unset / blank keeps the URL short and means "the server's default".
    expect(terminalWsPath({ cols: 80, rows: 24, tabName: "plain" })).not.toContain("profile");
    expect(
      terminalWsPath({ cols: 80, rows: 24, tabName: "plain", profile: "   " }),
    ).not.toContain("profile");
  });

  test("adds spawn command and env only for fresh terminal sessions", () => {
    const fresh = terminalWsPath({
      cols: 80,
      rows: 24,
      tabName: "agent",
      command: "./run-my-agent.sh",
      env: { CHAN_AGENT: "codex", TOKEN: "a=b" },
    });
    const freshQuery = new URL(fresh, "http://chan.test").searchParams;
    expect(freshQuery.get("command")).toBe("./run-my-agent.sh");
    expect(JSON.parse(freshQuery.get("env") ?? "null")).toEqual({
      CHAN_AGENT: "codex",
      TOKEN: "a=b",
    });

    const reattach = terminalWsPath({
      cols: 80,
      rows: 24,
      tabName: "agent",
      sessionId: "term_abc",
      command: "codex",
      env: { CHAN_AGENT: "codex" },
    });
    expect(reattach).not.toContain("command=");
    expect(reattach).not.toContain("env=");
  });
});
