// @vitest-environment jsdom
//
// The account page offers a browser entry to every devserver its user can
// open: Open and Copy link on the user's own rows and on the Shared with me
// rows alike. Both are the whole-devserver root on identity,
// `/s/{owner}?d=<disc>`, built from the owner's handle and the first 12 hex
// chars of the devserver id. identity admits the owner and every accepted
// grantee there, so the link a grantee copies is one they can use.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { meStore } from "../state/me.svelte";

const ORIGIN = "https://gw.example.test";
const OWN_ID = "a1b2c3d4e5f6".padEnd(64, "0");
const SHARED_ID = "0123456789ab".padEnd(64, "f");

const listOwnedDevservers = vi.fn();
const listIncomingShares = vi.fn();

vi.mock("../lib/api", async () => ({
  HttpError: (await import("@chan/web-shared/api")).HttpError,
  api: {
    discovery: vi.fn(async () => ({ tunnel_url: "https://proxy.example.test/v1/tunnel" })),
    me: vi.fn(),
    listOwnedDevservers: () => listOwnedDevservers(),
    listIncomingShares: () => listIncomingShares(),
    listDevserverGrants: vi.fn(async () => []),
    addDevserverGrant: vi.fn(),
    deleteDevserverGrant: vi.fn(),
  },
}));

const mounted: Array<Record<string, unknown>> = [];
const writeText = vi.fn(async (_text: string) => {});
/// Stands in for `window.location`: jsdom cannot navigate, and Open is a
/// navigation, so the test reads where it was sent from here.
let location: { origin: string; href: string };

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountDevservers(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const Component = (await import("./Devservers.svelte")).default;
  mounted.push(
    mount(Component, {
      target,
      props: { devservers: [{ devserver_id: OWN_ID, status: "online" }] },
    }) as Record<string, unknown>,
  );
  await flush();
  return target;
}

/// The card whose label carries `label`.
function card(target: HTMLElement, label: string): HTMLElement {
  const found = [...target.querySelectorAll<HTMLElement>("li.card")].find((li) =>
    li.querySelector(".label")?.textContent?.includes(label),
  );
  expect(found, `a card labelled ${label}`).toBeTruthy();
  return found as HTMLElement;
}

function buttonWith(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(found, `a ${text} button`).toBeTruthy();
  return found as HTMLButtonElement;
}

beforeEach(() => {
  location = { origin: ORIGIN, href: `${ORIGIN}/` };
  vi.stubGlobal("location", location);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  meStore.me = {
    user: {
      id: "u-alice",
      email: "alice@example.com",
      display_name: null,
      username: "alice",
      username_edits: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      avatar_url: null,
    },
    devservers: [{ devserver_id: OWN_ID, status: "online" }],
    flags: {},
  };
  listOwnedDevservers.mockResolvedValue([
    { devserver_id: OWN_ID, label: "alice-box", grant_count: 1 },
  ]);
  listIncomingShares.mockResolvedValue([
    {
      grant_id: "g1",
      owner_user_id: "u-bob",
      owner_username: "bob",
      owner_display_name: null,
      owner_avatar_url: null,
      devserver_id: SHARED_ID,
      label: "bob-box",
      accepted_at: "2026-11-01T00:00:00Z",
    },
  ]);
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  meStore.me = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a Shared with me row", () => {
  test("offers Open and Copy link to the owner's whole-devserver root", async () => {
    const target = await mountDevservers();
    const shared = card(target, "bob-box");
    expect(shared.textContent).toContain("from @bob");

    buttonWith(shared, "Copy link").click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/s/bob?d=0123456789ab`);
    expect(buttonWith(shared, "Copied")).toBeTruthy();
    // The copied state belongs to the row that copied.
    expect(buttonWith(card(target, "alice-box"), "Copy link")).toBeTruthy();

    buttonWith(shared, "Open").click();
    await flush();
    expect(location.href).toBe("/s/bob?d=0123456789ab");
  });
});

describe("a row of the user's own", () => {
  test("copies a link that does not claim only its owner can open it", async () => {
    const target = await mountDevservers();
    const own = card(target, "alice-box");

    const copy = buttonWith(own, "Copy link");
    expect(copy.title).not.toMatch(/only I/i);
    copy.click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/s/alice?d=a1b2c3d4e5f6`);

    buttonWith(own, "Open").click();
    await flush();
    expect(location.href).toBe("/s/alice?d=a1b2c3d4e5f6");
  });
});
