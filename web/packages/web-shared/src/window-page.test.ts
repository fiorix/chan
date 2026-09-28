import { afterEach, describe, expect, test, vi } from "vitest";
import { navigateWindowWhenReady, type WindowPageCheck } from "./window-page";

async function separateCallers() {
  vi.resetModules();
  const owner = await import("./window-page");
  vi.resetModules();
  const peer = await import("./window-page");
  expect(owner.navigateWindowWhenReady).not.toBe(peer.navigateWindowWhenReady);
  return { owner, peer };
}

function popup(initialHref = "about:blank") {
  const navigate = vi.fn();
  let href = initialHref;
  const window = {
    closed: false,
    document: document.implementation.createHTMLDocument(),
    focus: vi.fn(),
    location: { get href() { return href; }, set href(url: string) { navigate(url); } },
    showBlank() { href = "about:blank"; },
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
  test("follows a window another page is waiting on through navigation commit", async () => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup();
    const ownerCheck = vi.fn<WindowPageCheck>()
      .mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer());
    const peerCheck = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());
    const pending = owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck);
    await vi.advanceTimersByTimeAsync(0);
    child.window.document.body.textContent = "The first page owns this wait.";

    const following = peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck);
    await vi.advanceTimersByTimeAsync(0);

    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.window.focus).toHaveBeenCalledTimes(1);
    expect(child.window.document.body.textContent).toBe("The first page owns this wait.");
    expect(child.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(true);
    expect(await following).toBe(true);
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

type Connection = "connected" | "disconnected" | "gone";

const PAGE = "https://chan.test/project/?w=w-1";
const OWNER = "data-chan-window-page-owner";

function slowCheck() {
  return vi.fn<WindowPageCheck>(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return answer();
  });
}

function withReader(readConnection: (signal: AbortSignal) => Promise<Connection>) {
  return { focus: true, readConnection };
}

function heldReading() {
  let answerWith!: (connection: Connection) => void;
  const readConnection = vi.fn((_signal: AbortSignal) => new Promise<Connection>((resolve) => {
    answerWith = resolve;
  }));
  return { readConnection, answer: (connection: Connection) => answerWith?.(connection) };
}

describe("the connection read before navigation", () => {
  test("leaves a window that reads connected once its page answers", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const readConnection = vi.fn(async (_signal: AbortSignal): Promise<Connection> => "connected");
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(readConnection));
    await vi.advanceTimersByTimeAsync(99);
    expect(readConnection).not.toHaveBeenCalled();
    expect(child.window.document.documentElement.getAttribute(OWNER)).toMatch(/^waiting:\d+$/);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toBe(true);
    expect(child.navigate).not.toHaveBeenCalled();
    expect(child.window.document.documentElement.hasAttribute(OWNER)).toBe(false);
  });

  test("navigates a window that still reads disconnected, asking once with the wait's signal", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const readConnection = vi.fn(async (_signal: AbortSignal): Promise<Connection> => "disconnected");
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(readConnection));
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(true);
    expect(readConnection).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith(PAGE);
    expect(child.window.document.documentElement.getAttribute(OWNER)).toMatch(/^navigating:\d+$/);
  });

  test("ends the wait as for a closed window when the record is gone", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const readConnection = vi.fn(async (_signal: AbortSignal): Promise<Connection> => "gone");
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(readConnection));
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(false);
    expect(child.navigate).not.toHaveBeenCalled();
    expect(child.window.document.documentElement.hasAttribute(OWNER)).toBe(false);
  });

  test("navigates a blank window without reading its connection", async () => {
    vi.useFakeTimers();
    const child = popup();
    const readConnection = vi.fn(async (_signal: AbortSignal): Promise<Connection> => "connected");
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(readConnection));
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(true);
    expect(readConnection).not.toHaveBeenCalled();
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  test("navigates a window that turned blank while its connection was read", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const reading = heldReading();
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(reading.readConnection));
    await vi.advanceTimersByTimeAsync(100);
    child.window.showBlank();
    reading.answer("connected");

    expect(await pending).toBe(true);
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith(PAGE);
  });

  test("rejects once and keeps the page when the reading fails", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const readConnection = vi.fn(async (_signal: AbortSignal): Promise<Connection> => {
      throw new Error("The window's record could not be read.");
    });
    const pending = navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(readConnection));
    const outcome = pending.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    expect(await outcome).toMatchObject({ message: "The window's record could not be read." });
    expect(child.navigate).not.toHaveBeenCalled();
    expect(child.window.document.documentElement.hasAttribute(OWNER)).toBe(false);
  });

  test("navigates nothing when the window closes during the reading", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const reading = heldReading();
    let settled: unknown = "pending";
    void navigateWindowWhenReady(child.handle, PAGE, slowCheck(), withReader(reading.readConnection))
      .then((ready) => { settled = ready; }, (error: unknown) => { settled = error; });
    await vi.advanceTimersByTimeAsync(100);
    child.window.closed = true;
    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toBe(false);
    reading.answer("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(child.navigate).not.toHaveBeenCalled();
    expect(reading.readConnection.mock.calls[0][0].aborted).toBe(true);
  });

  test("bounds the reading by the wait's sixty seconds", async () => {
    vi.useFakeTimers();
    const child = popup(PAGE);
    const reading = heldReading();
    const check = vi.fn<WindowPageCheck>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 59_000));
      return answer();
    });
    let settled: unknown = "pending";
    void navigateWindowWhenReady(child.handle, PAGE, check, withReader(reading.readConnection))
      .then((ready) => { settled = ready; }, (error: unknown) => { settled = error; });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toMatchObject({ message: "Timed out waiting for the window page" });
    reading.answer("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(child.navigate).not.toHaveBeenCalled();
    expect(reading.readConnection.mock.calls[0][0].aborted).toBe(true);
    expect(child.window.document.documentElement.hasAttribute(OWNER)).toBe(false);
  });
});

describe("a window page mark that expires", () => {
  test.each([
    ["waiting", "whose time has passed", -1],
    ["navigating", "whose time has passed", -1],
    ["waiting", "that promises more than sixty seconds", 60_001],
    ["navigating", "that promises more than ten seconds", 10_001],
  ] as const)("a %s mark %s does not keep a caller out", async (phase, _label, offset) => {
    vi.useFakeTimers();
    const child = popup();
    child.window.document.documentElement.setAttribute(OWNER, `${phase}:${Date.now() + offset}`);
    const check = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());

    expect(await navigateWindowWhenReady(child.handle, "/caller", check)).toBe(true);

    expect(check).toHaveBeenCalledTimes(1);
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/caller");
    expect(child.window.document.documentElement.getAttribute(OWNER)).toMatch(/^navigating:\d+$/);
  });

  test("a navigation that has not committed keeps its window for ten seconds", async () => {
    vi.useFakeTimers();
    const child = popup();
    const check = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());

    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);
    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);

    expect(check).toHaveBeenCalledTimes(2);
    expect(child.navigate).toHaveBeenCalledTimes(2);
  });

  test("marks the document the window holds when its location is assigned", async () => {
    vi.useFakeTimers();
    const child = popup();
    const check = vi.fn<WindowPageCheck>()
      .mockImplementationOnce(async () => {
        child.window.document = document.implementation.createHTMLDocument();
        return answer();
      })
      .mockImplementation(async () => answer());

    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);

    expect(child.window.document.documentElement.getAttribute(OWNER)).toMatch(/^navigating:\d+$/);
    expect(await navigateWindowWhenReady(child.handle, PAGE, check)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(child.navigate).toHaveBeenCalledTimes(1);
  });
});

describe("a caller that finds another page's wait", () => {
  function outcomeOf(pending: Promise<boolean>) {
    const seen: { value: unknown } = { value: "pending" };
    void pending.then((ready) => { seen.value = ready; }, (error: unknown) => { seen.value = error; });
    return seen;
  }

  test("answers once that wait navigates, with no check of its own", async () => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup();
    const ownerCheck = vi.fn<WindowPageCheck>()
      .mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer());
    const peerCheck = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());
    const ownerAnswer = owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck);
    await vi.advanceTimersByTimeAsync(0);

    const peerAnswer = outcomeOf(peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(peerAnswer.value).toBe("pending");
    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.window.focus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ownerAnswer).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(peerAnswer.value).toBe(true);
    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/owner");
  });

  test.each(["blank", "page"] as const)("answers from what a refused wait leaves in a %s window", async (state) => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup(state === "blank" ? "about:blank" : PAGE);
    const ownerCheck = vi.fn<WindowPageCheck>()
      .mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer(409));
    const peerCheck = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());
    // The owner's caller closes a window only when it was blank.
    const ownerAnswer = owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck).catch((error: unknown) => {
      if (state === "blank") child.window.closed = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);

    const peerAnswer = outcomeOf(peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(peerAnswer.value).toBe("pending");
    expect(peerCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await ownerAnswer).toMatchObject({ message: "Please wait." });
    await vi.advanceTimersByTimeAsync(100);

    expect(peerAnswer.value).toBe(state === "page");
    expect(peerCheck).toHaveBeenCalledTimes(state === "page" ? 1 : 0);
    expect(child.navigate.mock.calls).toEqual(state === "page" ? [["/peer"]] : []);
  });

  test("takes a window whose owner left its waiting mark once the mark runs out", async () => {
    vi.useFakeTimers();
    const child = popup();
    child.window.document.documentElement.setAttribute(OWNER, `waiting:${Date.now() + 60_000}`);
    const check = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());

    const caller = outcomeOf(navigateWindowWhenReady(child.handle, "/caller", check));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(caller.value).toBe("pending");
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(caller.value).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/caller");
    expect(child.window.document.documentElement.getAttribute(OWNER)).toMatch(/^navigating:\d+$/);
  });

  test("answers once that wait's navigation has replaced the document", async () => {
    vi.useFakeTimers();
    const { owner, peer } = await separateCallers();
    const child = popup();
    child.navigate.mockImplementation(() => {
      child.window.document = document.implementation.createHTMLDocument();
    });
    const ownerCheck = vi.fn<WindowPageCheck>()
      .mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer());
    const peerCheck = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());
    void owner.navigateWindowWhenReady(child.handle, "/owner", ownerCheck);
    await vi.advanceTimersByTimeAsync(0);

    const peerAnswer = outcomeOf(peer.navigateWindowWhenReady(child.handle, "/peer", peerCheck));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(peerAnswer.value).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_100);

    expect(peerAnswer.value).toBe(true);
    expect(peerCheck).not.toHaveBeenCalled();
    expect(child.navigate).toHaveBeenCalledExactlyOnceWith("/owner");
  });

  test("answers closed once the user closes a window another page waits on", async () => {
    vi.useFakeTimers();
    const child = popup();
    child.window.document.documentElement.setAttribute(OWNER, `waiting:${Date.now() + 60_000}`);
    const check = vi.fn<WindowPageCheck>().mockImplementation(async () => answer());

    const caller = outcomeOf(navigateWindowWhenReady(child.handle, "/caller", check));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(caller.value).toBe("pending");
    child.window.closed = true;
    await vi.advanceTimersByTimeAsync(100);

    expect(caller.value).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(child.navigate).not.toHaveBeenCalled();
  });

  test.each(["answers", "refuses"] as const)("an owner whose window another page took when its page %s defers to that page", async (reply) => {
    vi.useFakeTimers();
    const child = popup();
    let release!: () => void;
    const check = vi.fn<WindowPageCheck>(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return answer(reply === "answers" ? 200 : 409);
    });
    const owner = outcomeOf(navigateWindowWhenReady(child.handle, "/owner", check));
    await vi.advanceTimersByTimeAsync(1_000);
    // The page that took the window after this wait's mark ran out.
    child.window.document.documentElement.setAttribute(OWNER, `waiting:${Date.now() + 60_000}`);
    release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(owner.value).toBe("pending");
    expect(child.navigate).not.toHaveBeenCalled();
    child.window.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(owner.value).toBe(false);
    expect(child.navigate).not.toHaveBeenCalled();
  });
});
