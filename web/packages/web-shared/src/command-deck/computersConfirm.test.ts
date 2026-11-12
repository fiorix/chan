import { describe, expect, it, vi } from "vitest";
import {
  createComputersConfirmations,
  type ComputersConfirmBridge,
} from "./computersConfirm";

function fakeBridge(): {
  bridge: ComputersConfirmBridge;
  liveTerminals: ReturnType<typeof vi.fn>;
  closeWindow: ReturnType<typeof vi.fn>;
  turnOff: ReturnType<typeof vi.fn>;
} {
  const liveTerminals = vi.fn();
  const closeWindow = vi.fn().mockResolvedValue(undefined);
  const turnOff = vi.fn();
  return {
    bridge: { liveTerminals, closeWindow, turnOff } as unknown as ComputersConfirmBridge,
    liveTerminals,
    closeWindow,
    turnOff,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const window = { key: "local:w-1", name: "Window 1" };
const workspace = { key: "local:ws-1", name: "Project" };

describe("closing a window", () => {
  it.each([
    [3, "3 terminal sessions in this window will stop."],
    [1, "1 terminal session in this window will stop."],
    [0, "This window will close."],
    [null, "Open sessions in this window may stop."],
    ["two", "Open sessions in this window may stop."],
  ])("names the count %s on its card", async (count, message) => {
    const { bridge, liveTerminals } = fakeBridge();
    liveTerminals.mockResolvedValue(count);
    const card = await createComputersConfirmations(bridge).closeWindow(window).confirm();
    expect(card).toEqual({ title: "Close Window 1?", message, actionLabel: "Close", danger: true });
    expect(liveTerminals).toHaveBeenCalledExactlyOnceWith("window", "local:w-1");
  });

  it("warns in general terms when the count cannot be read", async () => {
    const { bridge, liveTerminals } = fakeBridge();
    liveTerminals.mockRejectedValue(new Error("HTTP 503"));
    const card = await createComputersConfirmations(bridge).closeWindow(window).confirm();
    expect(card.message).toBe("Open sessions in this window may stop.");
  });

  it("closes on the count its card named", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    liveTerminals.mockResolvedValue(2);
    const close = createComputersConfirmations(bridge).closeWindow(window);
    await close.confirm();
    expect(await close.run()).toBeUndefined();
    expect(closeWindow).toHaveBeenCalledExactlyOnceWith("local:w-1");
  });

  it("asks again when the count moved, then closes on the new one", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    liveTerminals.mockResolvedValueOnce(0).mockResolvedValue(2);
    const close = createComputersConfirmations(bridge).closeWindow(window);
    await close.confirm();
    expect(await close.run()).toMatchObject({
      message: "2 terminal sessions in this window will stop.",
    });
    expect(closeWindow).not.toHaveBeenCalled();
    expect(await close.run()).toBeUndefined();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it("asks again for a card nothing here recorded", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    liveTerminals.mockResolvedValue(1);
    const close = createComputersConfirmations(bridge).closeWindow(window);
    expect(await close.run()).toMatchObject({
      message: "1 terminal session in this window will stop.",
    });
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("does not close on a reading a later card replaced", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    const recheck = deferred<number>();
    liveTerminals
      .mockResolvedValueOnce(5)
      .mockImplementationOnce(() => recheck.promise)
      .mockResolvedValueOnce(7);
    const close = createComputersConfirmations(bridge).closeWindow(window);
    await close.confirm();
    const overtaken = close.run();
    expect(await close.confirm()).toMatchObject({
      message: "7 terminal sessions in this window will stop.",
    });
    recheck.resolve(5);
    await overtaken;
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("forgets a reading when its window leaves the roster", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    liveTerminals.mockResolvedValue(2);
    const confirmations = createComputersConfirmations(bridge);
    await confirmations.closeWindow(window).confirm();
    confirmations.retain(new Set(), new Set());
    expect(await confirmations.closeWindow(window).run()).toMatchObject({
      message: "2 terminal sessions in this window will stop.",
    });
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("keeps the readings of the windows still listed", async () => {
    const { bridge, liveTerminals, closeWindow } = fakeBridge();
    liveTerminals.mockResolvedValue(2);
    const confirmations = createComputersConfirmations(bridge);
    await confirmations.closeWindow(window).confirm();
    confirmations.retain(new Set(["local:w-1"]), new Set());
    expect(await confirmations.closeWindow(window).run()).toBeUndefined();
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});

describe("turning a workspace off", () => {
  it.each([
    [2, "2 terminal sessions in this workspace will stop."],
    [0, "This workspace will turn off."],
    [null, "Open sessions in this workspace may stop."],
  ])("names the count %s on its card", async (count, message) => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(count);
    const card = await createComputersConfirmations(bridge).turnOffWorkspace(workspace).confirm();
    expect(card).toEqual({ title: "Turn off Project?", message, actionLabel: "Turn off", danger: true });
    expect(liveTerminals).toHaveBeenCalledExactlyOnceWith("workspace", "local:ws-1");
    expect(turnOff, "the card turns nothing off").not.toHaveBeenCalled();
  });

  it("stops the sessions its card named without asking again", async () => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(2);
    turnOff.mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    const off = createComputersConfirmations(bridge).turnOffWorkspace(workspace);
    await off.confirm();
    expect(await off.run(), "one confirmation is the whole exchange").toBeUndefined();
    expect(turnOff.mock.calls).toEqual([
      ["local:ws-1", false],
      ["local:ws-1", true],
    ]);
  });

  it("forces nothing when the workspace turns off unforced", async () => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(0);
    turnOff.mockResolvedValue(null);
    const off = createComputersConfirmations(bridge).turnOffWorkspace(workspace);
    await off.confirm();
    expect(await off.run()).toBeUndefined();
    expect(turnOff.mock.calls).toEqual([["local:ws-1", false]]);
  });

  it("asks again on the deck when the host's count is not the card's", async () => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(null);
    turnOff.mockResolvedValueOnce(3).mockResolvedValueOnce(3).mockResolvedValueOnce(null);
    const off = createComputersConfirmations(bridge).turnOffWorkspace(workspace);
    expect((await off.confirm()).message).toBe("Open sessions in this workspace may stop.");
    expect(await off.run()).toMatchObject({
      title: "Turn off Project?",
      message: "3 terminal sessions in this workspace will stop.",
    });
    expect(turnOff, "a count nobody saw is never forced past").toHaveBeenCalledExactlyOnceWith(
      "local:ws-1",
      false,
    );
    expect(await off.run()).toBeUndefined();
    expect(turnOff.mock.calls.at(-1)).toEqual(["local:ws-1", true]);
  });

  it("passes a refusal that names no count to the deck", async () => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(0);
    turnOff.mockRejectedValue(new Error("workspace is open in another Chan process"));
    const off = createComputersConfirmations(bridge).turnOffWorkspace(workspace);
    await off.confirm();
    await expect(off.run()).rejects.toThrow("workspace is open in another Chan process");
  });

  it("keeps a window's reading apart from a workspace's under one key", async () => {
    const { bridge, liveTerminals, turnOff } = fakeBridge();
    liveTerminals.mockResolvedValue(2);
    turnOff.mockResolvedValue(2);
    const confirmations = createComputersConfirmations(bridge);
    await confirmations.closeWindow({ key: "shared", name: "Window 1" }).confirm();
    expect(
      await confirmations.turnOffWorkspace({ key: "shared", name: "Project" }).run(),
      "the window's card is not the workspace's",
    ).toMatchObject({ title: "Turn off Project?" });
    expect(turnOff).toHaveBeenCalledExactlyOnceWith("shared", false);
  });
});
