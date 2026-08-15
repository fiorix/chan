// Devserver control attention events are flash-only: attention flashes the
// control row's eye, restored clears it. These tests cover the id parser (both
// wire shapes) and dispatch against the in-memory mock (seeded devserver `ds-1`,
// "prod", connected, library DS_LIBRARY_ID).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  controlEventId,
  onControlAttentionEvent,
  onControlRestoredEvent,
} from "./controlClosed.svelte";
import { library, loadLibrary, stopWatching } from "./library.svelte";
import {
  hasControlAttention,
  clearAllControlAttention,
  resolvePendingControlAttention,
} from "./controlAttention.svelte";
import type { DevserverEntry, WindowRecord } from "../api/library";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

beforeEach(async () => {
  clearAllControlAttention();
  // Seeds the devserver registry incl. ds-1, so markControlAttention can resolve
  // the devserver id to its library id.
  await loadLibrary();
});

afterEach(() => {
  stopWatching();
});

function devserver(over: Partial<DevserverEntry> & Pick<DevserverEntry, "id">): DevserverEntry {
  return {
    url: "http://host:8787",
    host: "host",
    port: 8787,
    label: "",
    script: "",
    has_token: true,
    library_id: null,
    status: "connected",
    pending_signin: false,
    auto_hide_control: false,
    os: "",
    pretty_name: null,
    gateway_id: null,
    gateway_url: "",
    shared: false,
    native_trust_required: false,
    ...over,
  };
}

function controlWindow(
  over: Partial<WindowRecord> & Pick<WindowRecord, "window_id" | "library_id">,
): WindowRecord {
  return {
    kind: "terminal",
    title: "Control terminal",
    ordinal: 0,
    workspace_path: null,
    prefix: "control",
    token: "token",
    persisted: false,
    connected: true,
    active_transfer: false,
    control: true,
    ...over,
  };
}

describe("controlEventId", () => {
  it("parses a bare string id", () => {
    expect(controlEventId("ds-1")).toBe("ds-1");
  });

  it("parses an { id } object", () => {
    expect(controlEventId({ id: "ds-2" })).toBe("ds-2");
  });

  it("returns null for an unrecognized payload", () => {
    expect(controlEventId(null)).toBeNull();
    expect(controlEventId(42)).toBeNull();
    expect(controlEventId("")).toBeNull();
    expect(controlEventId({})).toBeNull();
  });
});

describe("control attention events", () => {
  it("flashes the devserver's control library for attention", () => {
    const libId = library.devservers.find((d) => d.id === "ds-1")!.library_id!;
    expect(hasControlAttention(libId)).toBe(false);
    onControlAttentionEvent("ds-1");
    expect(hasControlAttention(libId)).toBe(true);
  });

  it("clears the devserver's control attention on restored", () => {
    const libId = library.devservers.find((d) => d.id === "ds-1")!.library_id!;
    onControlAttentionEvent("ds-1");
    expect(hasControlAttention(libId)).toBe(true);
    onControlRestoredEvent("ds-1");
    expect(hasControlAttention(libId)).toBe(false);
  });

  it("falls back to the control window row before the devserver registry learns library_id", () => {
    library.devservers = [devserver({ id: "fresh-ds", library_id: null })];
    library.windows = [
      controlWindow({
        window_id: "control-terminal-fresh-ds",
        library_id: "lib-fresh",
      }),
    ];

    onControlAttentionEvent("fresh-ds");

    expect(hasControlAttention("lib-fresh")).toBe(true);
  });

  it("resolves by the current control window before a stale devserver library_id", () => {
    library.devservers = [devserver({ id: "stale-ds", library_id: "lib-stale" })];
    library.windows = [
      controlWindow({
        window_id: "control-terminal-stale-ds",
        library_id: "lib-current",
      }),
    ];

    onControlAttentionEvent("stale-ds");

    expect(hasControlAttention("lib-current")).toBe(true);
    expect(hasControlAttention("lib-stale")).toBe(false);
  });

  it("replays an exit event that arrives before the control window feed row", () => {
    library.devservers = [devserver({ id: "racy-ds", library_id: null })];
    library.windows = [];

    onControlAttentionEvent("racy-ds");
    expect(hasControlAttention("lib-racy")).toBe(false);

    library.windows = [
      controlWindow({
        window_id: "control-terminal-racy-ds",
        library_id: "lib-racy",
      }),
    ];
    resolvePendingControlAttention();

    expect(hasControlAttention("lib-racy")).toBe(true);
  });

  it("ignores an unrecognized payload", () => {
    const libId = library.devservers.find((d) => d.id === "ds-1")!.library_id!;
    onControlAttentionEvent(null);
    expect(hasControlAttention(libId)).toBe(false);
  });
});
