import { describe, it, expect } from "vitest";
import type { WindowRecord } from "../api/library";
import { windowUrl } from "./windowUrl";

const ORIGIN = "http://127.0.0.1:8787";

function record(over: Partial<WindowRecord>): WindowRecord {
  return {
    window_id: "w-abc",
    library_id: "local",
    kind: "workspace",
    title: "Window 1",
    ordinal: 1,
    workspace_path: "/Users/x/proj",
    prefix: "proj-1a2b3c4d",
    token: "tok_live",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
    ...over,
  };
}

describe("windowUrl", () => {
  it("composes a workspace window under the serving origin with w/lib/t and no kind", () => {
    const u = new URL(windowUrl(record({}), ORIGIN));
    expect(u.origin).toBe(ORIGIN);
    expect(u.pathname).toBe("/proj-1a2b3c4d/");
    expect(u.searchParams.get("w")).toBe("w-abc");
    expect(u.searchParams.get("kind")).toBeNull();
    expect(u.searchParams.get("lib")).toBe("local");
    expect(u.searchParams.get("t")).toBe("tok_live");
  });

  it("stamps kind=terminal for a standalone terminal", () => {
    const u = new URL(windowUrl(record({ kind: "terminal", prefix: "terminal-3" }), ORIGIN));
    expect(u.pathname).toBe("/terminal-3/");
    expect(u.searchParams.get("kind")).toBe("terminal");
  });

  it("stamps kind=control for a control terminal", () => {
    const u = new URL(windowUrl(record({ kind: "terminal", control: true, prefix: "control-2" }), ORIGIN));
    expect(u.searchParams.get("kind")).toBe("control");
  });

  it("always stamps ?w= even for a plain record", () => {
    const u = new URL(windowUrl(record({ window_id: "w-xyz" }), ORIGIN));
    expect(u.searchParams.get("w")).toBe("w-xyz");
  });

  it("omits ?t= when the tenant is off (empty token)", () => {
    const u = new URL(windowUrl(record({ token: "" }), ORIGIN));
    expect(u.searchParams.has("t")).toBe(false);
  });

  it("normalizes a leading/trailing-slash prefix and keeps multi-segment prefixes", () => {
    const u = new URL(windowUrl(record({ prefix: "/w/linux/" }), ORIGIN));
    expect(u.pathname).toBe("/w/linux/");
  });

  it("carries a remote library id for a devserver window", () => {
    const u = new URL(windowUrl(record({ library_id: "lib-00ff11ee" }), ORIGIN));
    expect(u.searchParams.get("lib")).toBe("lib-00ff11ee");
  });
});
