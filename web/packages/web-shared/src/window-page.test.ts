import { afterEach, describe, expect, test, vi } from "vitest";
import type { WindowPageCheck } from "./window-page";

async function separateCallers() {
  vi.resetModules();
  const owner = await import("./window-page");
  vi.resetModules();
  const peer = await import("./window-page");
  expect(owner.navigateWindowWhenReady).not.toBe(peer.navigateWindowWhenReady);
  return { owner, peer };
}

function popup() {
  const navigate = vi.fn();
  const window = {
    closed: false,
    document: document.implementation.createHTMLDocument(),
    focus: vi.fn(),
    location: { get href() { return "about:blank"; }, set href(url: string) { navigate(url); } },
  };
  return { window, handle: window as unknown as Window, navigate };
}

function answer(status = 200): Awaited<ReturnType<WindowPageCheck>> {
  return {
    response: new Response(status === 200 ? "<html></html>" : '{"error":"Please wait."}', {
      status, headers: { "Retry-After": "2" },
    }),
    readRefusal: async () => new Error("Please wait."),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("window page ownership between callers", () => {
  test("focuses a window another page is waiting on through navigation commit", async () => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup();
    const ownerCheck = vi.fn<WindowPageCheck>()
      .mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer());
    const peerCheck = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());
    const pending = owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck);
    await vi.advanceTimersByTimeAsync(0);
    child.window.document.body.textContent = "The first page owns this wait.";

    await peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck);

    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.window.focus).toHaveBeenCalledTimes(1);
    expect(child.window.document.body.textContent).toBe("The first page owns this wait.");
    expect(child.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(true);
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/owner");
    await peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck);
    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.navigate).toHaveBeenCalledTimes(1);

    child.window.document = document.implementation.createHTMLDocument();
    await peer.navigateWindowWhenReady(child.handle, "/replacement", peerCheck);
    expect(peerCheck).toHaveBeenCalledTimes(1);
    expect(child.navigate).toHaveBeenLastCalledWith("/replacement");
  });

  test("releases a refused wait so another page can own a later attempt", async () => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup();
    const ownerCheck = vi.fn<WindowPageCheck>().mockResolvedValue(answer(409));
    const peerCheck = vi.fn<WindowPageCheck>().mockResolvedValue(answer());

    await expect(owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck)).rejects.toThrow("Please wait.");
    expect(child.navigate).not.toHaveBeenCalled();
    expect(await peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck)).toBe(true);
    expect(peerCheck).toHaveBeenCalledTimes(1);
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/peer");
  });
});
