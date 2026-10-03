import { describe, expect, it, vi } from "vitest";
import { coalescedLiveRefresh } from "./liveRefresh";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("coalescedLiveRefresh", () => {
  it("queues one fresh read for any number of pushes during a read", async () => {
    const first = deferred();
    const second = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const after = vi.fn();
    const refresh = coalescedLiveRefresh(read, after);

    const running = refresh();
    void refresh();
    void refresh();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(after).not.toHaveBeenCalled();
    second.resolve();
    await running;
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("swallows a live-read error and permits the next push to retry", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const after = vi.fn();
    const refresh = coalescedLiveRefresh(read, after);

    await expect(refresh()).resolves.toBeUndefined();
    expect(after).not.toHaveBeenCalled();
    await refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
