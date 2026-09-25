// @vitest-environment jsdom
//
// A window minted BY a routed `cs open` carries `seed=0` in its URL and must
// not seed itself with a default terminal: the tab it is about to be handed
// IS its content. Everything else, `cs window new` included, keeps seeding
// one, because that is what those mean. Delivery of the routed tab is
// take-once and unacknowledged (`ws.rs` removes every parked frame before
// sending any), so the window falls back to a terminal if nothing arrives.
// A browser surface mints such windows itself, as tabs, and marks them the
// same way.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalConfig } from "../api/types";
import { ApiError } from "../api/errors";
import { preferences, serveMeta } from "../__tests__/standalone";

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      config: () => apiConfig(),
      workspace: () => Promise.reject(new ApiError(404, "not found")),
      getSession: () => Promise.resolve(null),
      putSession: () => Promise.resolve(),
    },
    openWatchSocket: () => () => {},
  };
});

let store: typeof import("./store.svelte");
let tabs: typeof import("./tabs.svelte");

/// Boot a standalone terminal window served at `query`.
async function boot(query: string): Promise<void> {
  window.history.replaceState({}, "", `/?${query}`);
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  await store.bootstrap();
}

function openKinds(): string[] {
  const kinds: string[] = [];
  for (const node of Object.values(tabs.layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of tabs.allPaneTabs(node)) kinds.push(tab.kind);
  }
  return kinds;
}

beforeEach(() => {
  vi.resetModules();
  apiConfig.mockResolvedValue({ revision: 1, preferences: preferences(), workspaces: [] });
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a window a routed open minted", () => {
  test("boots with no tab, waiting for the one it was minted for", async () => {
    await boot("kind=terminal&w=w-routed&seed=0");

    expect(openKinds()).toEqual([]);
  });

  test("any other standalone window boots on a terminal", async () => {
    await boot("kind=terminal&w=w-plain");

    expect(openKinds()).toEqual(["terminal"]);
  });

  test("falls back to a terminal when nothing arrives within ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await boot("kind=terminal&w=w-routed&seed=0");

    await vi.advanceTimersByTimeAsync(9_999);
    expect(openKinds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(openKinds()).toEqual(["terminal"]);
  });

  test("adds nothing once its tab has arrived", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await boot("kind=terminal&w=w-routed&seed=0");
    tabs.openTerminalInActivePane({});

    await vi.advanceTimersByTimeAsync(10_000);
    expect(openKinds()).toEqual(["terminal"]);
  });
});

describe("a browser minting a routed window", () => {
  test("opens it as a tab marked seed=0", async () => {
    await boot("kind=terminal&w=w-source");
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    store.onWatchEvent({
      type: "window_command",
      window_id: "w-source",
      command: "open_window",
      window: "w-routed",
      prefix: "/lib/x",
      token: "secret",
      path: "notes/a.md",
    });

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const [target, name] = open.mock.calls[0]!;
    const url = new URL(String(target));
    expect(name).toBe("w-routed");
    expect(url.pathname).toBe("/lib/x/");
    expect(url.searchParams.get("w")).toBe("w-routed");
    expect(url.searchParams.get("kind")).toBe("terminal");
    expect(url.searchParams.get("seed")).toBe("0");
  });
});
