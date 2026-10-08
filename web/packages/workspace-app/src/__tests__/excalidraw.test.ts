// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import {
  boardLoaded,
  drawableBoard,
  drawableBoards,
  reactDom,
  standInForBoards,
} from "./excalidraw";

afterEach(() => {
  vi.restoreAllMocks();
});

/// What a wait has come to once the work already queued has run: its
/// outcome, or "pending".
async function state(wait: Promise<unknown>): Promise<string> {
  const outcome = wait.then(
    () => "done",
    (error: unknown) => `failed: ${String(error)}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Promise.race([outcome, Promise.resolve("pending")]);
}

// A board's modules load in the time the machine gives them, so the waits
// follow the board's own events and hold no deadline of their own.
test("boardLoaded waits for the board's root and polls nothing", async () => {
  const poll = vi.spyOn(vi, "waitFor");
  await standInForBoards();

  const loaded = boardLoaded();
  expect(await state(loaded), "before a root is made").toBe("pending");

  reactDom.createRoot({});
  expect(await state(loaded), "once a root is made").toBe("done");
  expect(await state(boardLoaded()), "asked after the root").toBe("done");
  expect(poll, "polling waits").not.toHaveBeenCalled();

  // The next test's boards are not this test's.
  await standInForBoards();
  expect(await state(boardLoaded()), "after the stand-ins are renewed").toBe(
    "pending",
  );
});

test("drawableBoard waits for the board's render and polls nothing", async () => {
  const poll = vi.spyOn(vi, "waitFor");
  await standInForBoards();
  drawableBoards();

  const drawn = drawableBoard();
  const root = reactDom.createRoot({});
  expect(await state(drawn), "a root with nothing rendered").toBe("pending");

  root.render({ props: {} });
  expect(await state(drawn), "once the board has rendered").toBe("done");
  expect(await state(drawableBoard()), "asked after the render").toBe("done");
  expect(poll, "polling waits").not.toHaveBeenCalled();

  drawableBoards();
  expect(await state(drawableBoard()), "after a new drawable board is asked for").toBe(
    "pending",
  );
});
