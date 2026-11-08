import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("launcher navigation across page loads", () => {
  it("restores both decks independently without restoring focus or opening a form", async () => {
    const first = await import("./deck.svelte");
    first.showCard("computers", "devserver:prod", { turn: -7, focus: true });
    first.showAddForm("gateways", "add-gateway");

    vi.resetModules();
    const reloaded = await import("./deck.svelte");
    expect(reloaded.decks.computers).toEqual({ activeKey: "devserver:prod", turn: -7, focusSeq: 0, openForm: false });
    expect(reloaded.decks.gateways).toEqual({ activeKey: "add-gateway", turn: 0, focusSeq: 0, openForm: false });
  });

  it("restores the selected screen without replaying its flip animation", async () => {
    const first = await import("./screen.svelte");
    first.showScreen("gateways");

    vi.resetModules();
    const reloaded = await import("./screen.svelte");
    expect(reloaded.screen).toEqual({ current: "gateways", flips: 0 });
    reloaded.showScreen("computers");

    vi.resetModules();
    const again = await import("./screen.svelte");
    expect(again.screen.current).toBe("computers");
  });

  it.each(["{", '{"activeKey":42,"turn":0}', '{"activeKey":"local","turn":1.5}'])(
    "ignores invalid saved navigation: %s", async (saved) => {
      sessionStorage.setItem("chan.launcher-deck.v1:computers", saved);
      sessionStorage.setItem("chan.launcher-screen.v1", "unknown");
      const { decks } = await import("./deck.svelte");
      const { screen } = await import("./screen.svelte");
      expect(decks.computers.activeKey).toBeNull();
      expect(decks.computers.turn).toBe(0);
      expect(screen.current).toBe("computers");
    },
  );

  it("keeps navigation working when session storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { decks, showCard } = await import("./deck.svelte");
    const { screen, showScreen } = await import("./screen.svelte");
    showCard("computers", "local");
    showScreen("gateways");
    expect(decks.computers.activeKey).toBe("local");
    expect(screen.current).toBe("gateways");
  });
});
