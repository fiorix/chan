// @vitest-environment jsdom
//
// Revoking is the one thing on this surface that takes access away, so a
// revoke that failed must never read like one that worked. A token row
// whose DELETE was refused has to stay, say why, and leave no unhandled
// rejection; a grant list whose DELETE was refused has to stay on screen
// with the error beside it, so the user can see who still holds access
// and try again without reloading.
//
// The identity service answers 403 on every management endpoint for a
// blocked account, which is the refusal these drive.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const REFUSAL = "account is blocked";
/// What the service answers the second DELETE: the grant is already gone.
const GONE = "no such grant";

const listTokens = vi.fn();
const revokeToken = vi.fn();
const listOwnedDevservers = vi.fn();
const listIncomingShares = vi.fn();
const listDevserverGrants = vi.fn();
const deleteDevserverGrant = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listTokens: () => listTokens(),
    revokeToken: (id: string) => revokeToken(id),
    createToken: vi.fn(),
    tokenAudit: vi.fn(async () => []),
    listOwnedDevservers: () => listOwnedDevservers(),
    listIncomingShares: () => listIncomingShares(),
    listDevserverGrants: (id: string) => listDevserverGrants(id),
    deleteDevserverGrant: (id: string) => deleteDevserverGrant(id),
    addDevserverGrant: vi.fn(),
    listInvites: vi.fn(async () => []),
  },
}));

const mounted: Array<Record<string, unknown>> = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
/// The runner's process: an unhandled rejection here is Node's, and a
/// listener on jsdom's window would never hear it.
const runner = globalThis as unknown as {
  process: {
    on: (e: "unhandledRejection", fn: (r: unknown) => void) => void;
    off: (e: "unhandledRejection", fn: (r: unknown) => void) => void;
  };
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountView(
  mod: string,
  props: Record<string, unknown> = {},
): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  const Component = (await import(mod)).default;
  mounted.push(mount(Component, { target, props }) as Record<string, unknown>);
  await flush();
  return target;
}

function buttonWith(target: HTMLElement, text: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(found, `a ${text} button`).toBeTruthy();
  return found as HTMLButtonElement;
}

beforeEach(() => {
  unhandled.length = 0;
  runner.process.on("unhandledRejection", onUnhandled);
  listTokens.mockResolvedValue([
    {
      id: "t1",
      label: "laptop",
      created_at: "2026-01-01T00:00:00Z",
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    },
  ]);
  revokeToken.mockRejectedValue(new Error(REFUSAL));
  listOwnedDevservers.mockResolvedValue([
    { devserver_id: "d1abcdef0123456", label: "box", grant_count: 1 },
  ]);
  listIncomingShares.mockResolvedValue([]);
  listDevserverGrants.mockResolvedValue([
    { id: "g1", grantee_email: "friend@example.com", accepted_at: null },
  ]);
  deleteDevserverGrant.mockRejectedValue(new Error(REFUSAL));
});

afterEach(() => {
  runner.process.off("unhandledRejection", onUnhandled);
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("a token revoke the service refuses", () => {
  test("keeps the row, says why, and leaves no unhandled rejection", async () => {
    const target = await mountView("./Tokens.svelte");
    expect(target.textContent).toContain("laptop");

    buttonWith(target, "Revoke").click();
    await flush();
    // The confirmation is the app's own, so it is in the document.
    const confirmBtn = [...target.querySelectorAll("button")].find((b) =>
      /revoke/i.test(b.textContent ?? ""),
    );
    expect(confirmBtn, "a confirm control").toBeTruthy();
    for (const b of [...target.querySelectorAll("button")]) {
      if (b.textContent?.trim() === "Revoke token") b.click();
    }
    await flush();

    expect(revokeToken).toHaveBeenCalledWith("t1");
    expect(unhandled).toEqual([]);
    expect(target.textContent).toContain("laptop");
    expect(target.textContent).toContain(REFUSAL);
  });
});

describe("a grant revoke the service refuses", () => {
  test("keeps the grant list on screen with the error beside it", async () => {
    // `devservers` is the live tunnel snapshot the parent passes in;
    // none is online here, which leaves the owned row as the only one.
    const target = await mountView("./Devservers.svelte", { devservers: [] });
    buttonWith(target, "Share").click();
    await flush();
    expect(target.textContent).toContain("friend@example.com");

    buttonWith(target, "Revoke").click();
    await flush();

    expect(deleteDevserverGrant).toHaveBeenCalledWith("g1");
    expect(unhandled).toEqual([]);
    // Who still holds access is the point of the panel; the failure sits
    // beside it rather than replacing it.
    expect(target.textContent).toContain("friend@example.com");
    expect(target.textContent).toContain(REFUSAL);
    // And the control is still there to try again with.
    expect(
      [...target.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Revoke",
      ),
    ).toBe(true);
  });
});

describe("a grant revoke clicked twice", () => {
  test("holds the control down while its DELETE is in flight", async () => {
    deleteDevserverGrant.mockReturnValue(new Promise(() => {}));
    const target = await mountView("./Devservers.svelte", { devservers: [] });
    buttonWith(target, "Share").click();
    await flush();

    const revoke = buttonWith(target, "Revoke");
    revoke.click();
    await flush();
    expect(revoke.disabled).toBe(true);
  });

  test("sends one DELETE, so a revoke that worked is not reported as failed", async () => {
    let settleFirst: (() => void) | null = null;
    let calls = 0;
    deleteDevserverGrant.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          settleFirst = () => resolve();
        });
      }
      return Promise.reject(new Error(GONE));
    });

    const target = await mountView("./Devservers.svelte", { devservers: [] });
    buttonWith(target, "Share").click();
    await flush();

    // Two clicks inside one frame, which is what a double click is. The
    // DOM has not been updated between them, so the disabled attribute
    // alone cannot be what stops the second.
    const revoke = buttonWith(target, "Revoke");
    revoke.click();
    revoke.click();
    await flush();

    settleFirst?.();
    await flush();

    expect(deleteDevserverGrant).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    // The grantee is gone and nothing claims otherwise.
    expect(target.textContent).not.toContain("friend@example.com");
    expect(target.textContent).not.toContain("Not revoked");
  });
});
