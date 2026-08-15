import { describe, it, expect, beforeEach } from "vitest";
import { library } from "./library.svelte";
import {
  controlAttention,
  pruneControlAttention,
  clearAllControlAttention,
} from "./controlAttention.svelte";
import type { WindowRecord } from "../api/library";

function controlWin(libraryId: string): WindowRecord {
  return {
    window_id: `control-terminal-${libraryId}`,
    library_id: libraryId,
    kind: "terminal",
    title: "Control terminal",
    ordinal: 0,
    workspace_path: null,
    prefix: "",
    token: "",
    persisted: true,
    connected: false,
    active_transfer: false,
    control: true,
  };
}

beforeEach(() => {
  clearAllControlAttention();
  library.windows = [];
});

describe("pruneControlAttention (D-D)", () => {
  it("keeps a flag while its library still owns a control window in the feed", () => {
    // Script died -> connection down, control terminal kept alive + flashing.
    library.windows = [controlWin("lib-a")];
    controlAttention.libs["lib-a"] = true;
    pruneControlAttention();
    expect(controlAttention.libs["lib-a"]).toBe(true);
  });

  it("prunes a flag whose control window has left the feed (reaped/torn-down)", () => {
    library.windows = []; // control terminal closed -> gone from the feed
    controlAttention.libs["lib-a"] = true;
    pruneControlAttention();
    expect("lib-a" in controlAttention.libs).toBe(false);
  });

  it("prunes only the dead library and keeps the live one", () => {
    library.windows = [controlWin("lib-live")];
    controlAttention.libs["lib-live"] = true;
    controlAttention.libs["lib-dead"] = true; // reconnected under a new id / torn down
    pruneControlAttention();
    expect(controlAttention.libs["lib-live"]).toBe(true);
    expect("lib-dead" in controlAttention.libs).toBe(false);
  });
});
