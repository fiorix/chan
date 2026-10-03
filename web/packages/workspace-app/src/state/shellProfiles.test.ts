import { beforeEach, describe, expect, test, vi } from "vitest";

// The store fetches through the api client; stub it per-test.
const terminalShells = vi.fn();
vi.mock("../api/client", () => ({ api: { terminalShells: () => terminalShells() } }));

async function freshStore() {
  vi.resetModules();
  return await import("./shellProfiles.svelte");
}

describe("shell profile store", () => {
  beforeEach(() => {
    terminalShells.mockReset();
  });

  test("loads once and shares an in-flight request between callers", async () => {
    terminalShells.mockResolvedValue({
      profiles: [
        { id: "pwsh", name: "PowerShell", program: "C:/pwsh.exe", kind: "powershell", source: "discovered" },
        { id: "git-bash", name: "Git Bash", program: "C:/Git/bin/bash.exe", kind: "posix", source: "discovered" },
      ],
      default_profile: "pwsh",
    });
    const store = await freshStore();

    // Several panes mount at once; that must be one request, not three.
    await Promise.all([
      store.ensureShellProfiles(),
      store.ensureShellProfiles(),
      store.ensureShellProfiles(),
    ]);
    expect(terminalShells).toHaveBeenCalledTimes(1);
    expect(store.shellProfiles().map((p) => p.id)).toEqual(["pwsh", "git-bash"]);
    expect(store.defaultShellProfileId()).toBe("pwsh");

    // Already loaded: no refetch.
    await store.ensureShellProfiles();
    expect(terminalShells).toHaveBeenCalledTimes(1);
  });

  /// An older server has no /api/terminal/shells. That must degrade to "no
  /// picker", never throw and never block the pane from rendering.
  test("a failing endpoint leaves an empty list rather than throwing", async () => {
    terminalShells.mockRejectedValue(new Error("404 not found"));
    const store = await freshStore();

    await expect(store.ensureShellProfiles()).resolves.toBeUndefined();
    expect(store.shellProfiles()).toEqual([]);
    expect(store.defaultShellProfileId()).toBeNull();
    expect(store.shellProfilesLoaded()).toBe(true);
  });

  test("a stale profile id still labels, falling back to the id", async () => {
    terminalShells.mockResolvedValue({
      profiles: [
        { id: "git-bash", name: "Git Bash", program: "C:/Git/bin/bash.exe", kind: "posix", source: "discovered" },
      ],
      default_profile: null,
    });
    const store = await freshStore();
    await store.ensureShellProfiles();

    expect(store.shellProfileLabel("git-bash")).toBe("Git Bash");
    // A tab restored from a hash can name a profile this machine no longer
    // has; showing the raw id beats showing nothing.
    expect(store.shellProfileLabel("wsl:Removed")).toBe("wsl:Removed");
    expect(store.shellProfileLabel(undefined)).toBeNull();
  });

  test("reload drops the cache and refetches", async () => {
    terminalShells.mockResolvedValue({ profiles: [], default_profile: null });
    const store = await freshStore();
    await store.ensureShellProfiles();
    expect(terminalShells).toHaveBeenCalledTimes(1);

    await store.reloadShellProfiles();
    expect(terminalShells).toHaveBeenCalledTimes(2);
  });
});


test("reload owns profiles and loading state across stale settlements", async () => {
  for (const fail of [false, true]) {
    for (const staleFinishesLast of [false, true]) {
      terminalShells.mockReset();
      const store = await freshStore();
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: Error) => void;
      let resolveCurrent!: (value: unknown) => void;
      const oldResponse = new Promise((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const currentResponse = new Promise((resolve) => { resolveCurrent = resolve; });
      terminalShells.mockReturnValueOnce(oldResponse).mockReturnValueOnce(currentResponse);
      const oldRequest = store.ensureShellProfiles();
      const currentRequest = store.reloadShellProfiles();
      const current = {
        profiles: [{ id: "current", name: "Current shell", program: "/bin/sh", kind: "posix", source: "discovered" }],
        default_profile: "current",
      };
      if (staleFinishesLast) {
        resolveCurrent(current);
        await currentRequest;
      }
      if (fail) rejectOld(new Error("old request failed"));
      else resolveOld({ profiles: [{ id: "old", name: "Old shell", program: "/bin/sh", kind: "posix", source: "discovered" }], default_profile: "old" });
      await oldRequest;

      expect(store.shellProfilesLoaded()).toBe(staleFinishesLast);
      expect(store.shellProfiles().map((p) => p.id)).toEqual(staleFinishesLast ? ["current"] : []);
      expect(store.defaultShellProfileId()).toBe(staleFinishesLast ? "current" : null);
      if (!staleFinishesLast) {
        expect(store.ensureShellProfiles()).toBe(currentRequest);
        resolveCurrent(current);
        await currentRequest;
      }
      expect(store.shellProfiles().map((p) => p.id)).toEqual(["current"]);
      expect(store.defaultShellProfileId()).toBe("current");
      expect(terminalShells).toHaveBeenCalledTimes(2);
    }
  }
});
