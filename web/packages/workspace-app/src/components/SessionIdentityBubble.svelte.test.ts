// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reply: vi.fn() }));
vi.mock("../api/client", () => ({ api: { windowReply: mocks.reply } }));
vi.mock("../api/transport", () => ({ request: vi.fn() }));

import SessionIdentityBubble from "./SessionIdentityBubble.svelte";
import { clientSession, endClientIdentification, identifyClient, syncClientIdentifications } from "../state/clientSession.svelte";

let view: Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  syncClientIdentifications([]);
  clientSession.id = "client-home";
  clientSession.requestId = null;
  clientSession.busy = false;
  clientSession.detached = false;
});

afterEach(() => {
  if (view) unmount(view);
  view = undefined;
  document.body.replaceChildren();
});

test.each(["start", "sync"] as const)("the card stays locked through a repeated %s for its request", async (frame) => {
  let settle!: () => void;
  const replyResult = new Promise<void>((resolve) => { settle = resolve; });
  mocks.reply.mockReturnValue(replyResult);
  syncClientIdentifications(["live-request"]);
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(SessionIdentityBubble, { target });
  flushSync();
  const buttons = [...target.querySelectorAll<HTMLButtonElement>("button")];
  const identify = buttons.find((button) => button.textContent?.trim() === "Identify this client")!;
  const cancel = buttons.find((button) => button.textContent?.trim() === "Cancel")!;

  identify.click();
  flushSync();
  expect(cancel.disabled).toBe(true);
  if (frame === "start") identifyClient("live-request");
  else syncClientIdentifications(["live-request"]);
  flushSync();
  expect(cancel.disabled).toBe(true);
  cancel.click();
  expect(mocks.reply).toHaveBeenCalledExactlyOnceWith({
    requestId: "live-request", payload: { client_id: "client-home" },
  });

  settle();
  await replyResult;
  flushSync();
});

test.each([false, true])("an accepted answer stays locked through a buffered start, replay=%s", async (replay) => {
  mocks.reply.mockResolvedValue(undefined);
  syncClientIdentifications(["live-request"]);
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(SessionIdentityBubble, { target });
  flushSync();
  const button = (label: string) => [...target.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label)!;

  button("Identify this client").click();
  await mocks.reply.mock.results[0]!.value;
  await tick();
  if (replay) identifyClient("live-request");
  flushSync();
  expect(target.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button("Cancel").disabled).toBe(true);
  button("Cancel").click();
  expect(mocks.reply).toHaveBeenCalledExactlyOnceWith({
    requestId: "live-request", payload: { client_id: "client-home" },
  });

  endClientIdentification("live-request");
  flushSync();
  expect(target.querySelector('[role="dialog"]')).toBeNull();
});
