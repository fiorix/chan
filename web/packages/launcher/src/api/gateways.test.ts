// The gateway client surface: the live client's routes are a frozen wire
// contract (the server pins the same paths byte-for-byte), the mock keeps
// CRUD exercisable in-memory with no seeds, and the demo fabricates one
// sample gateway for its populated variant.

import { describe, it, expect, afterEach, vi } from "vitest";
import { ApiError, liveApi, type GatewayEntry } from "./library";
import { mockApi, resetMockGateways } from "./mock";
import { createLauncherDemoApi } from "./demo";

describe("liveApi gateway routes (frozen wire)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status = 200, body: unknown = []): { calls: [string, RequestInit][] } {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init ?? {}]);
        return new Response(status === 204 ? null : JSON.stringify(body), { status });
      }),
    );
    return { calls };
  }

  it("lists, adds, updates, removes, connects, and disconnects on /api/library/gateways", async () => {
    const { calls } = stubFetch();
    await liveApi.listGateways();
    const { calls: post } = stubFetch(200, {});
    await liveApi.addGateway({
      url: "https://gw.chan.app",
      label: "",
      wireguard: "~/.config/chan/gateway.conf",
    });
    const { calls: putCalls } = stubFetch(200, {});
    await liveApi.updateGateway("gw-1a2b3c4d", { url: "https://gw.chan.app", label: "prod" });
    const { calls: rest } = stubFetch(204);
    await liveApi.removeGateway("gw-1a2b3c4d");
    await liveApi.connectGateway("gw-1a2b3c4d");
    await liveApi.disconnectGateway("gw-1a2b3c4d");
    const { calls: keyCalls } = stubFetch(200, {});
    await liveApi.generateWireguardKey("gw-1a2b3c4d");

    expect(calls[0][0]).toBe("/api/library/gateways");
    expect(calls[0][1].method).toBe("GET");
    expect(post[0][0]).toBe("/api/library/gateways");
    expect(post[0][1].method).toBe("POST");
    expect(post[0][1].body).toBe(
      JSON.stringify({
        url: "https://gw.chan.app",
        label: "",
        wireguard: "~/.config/chan/gateway.conf",
      }),
    );
    expect(putCalls[0][0]).toBe("/api/library/gateways/gw-1a2b3c4d");
    expect(putCalls[0][1].method).toBe("PUT");
    expect(putCalls[0][1].body).toBe(
      JSON.stringify({ url: "https://gw.chan.app", label: "prod" }),
    );
    expect(rest.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/library/gateways/gw-1a2b3c4d", "DELETE"],
      ["/api/library/gateways/gw-1a2b3c4d/connect", "POST"],
      ["/api/library/gateways/gw-1a2b3c4d/disconnect", "POST"],
    ]);
    expect(keyCalls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ["/api/library/gateways/gw-1a2b3c4d/wireguard-key", "POST", undefined],
    ]);
  });

  it("parses the pinned GatewayEntry wire shape", async () => {
    // The server's byte-pinned sample: every key present, no extras consumed.
    // `satisfies` makes svelte-check the gate on the mirror: a key the Rust
    // struct gained and this type lacks, or the reverse, fails there, where
    // vitest alone would pass with the types stripped.
    const wire = {
      id: "gw-1a2b3c4d",
      url: "https://gw.chan.app",
      label: "",
      enabled: true,
      status: "disconnected",
      pending_signin: false,
      devserver_count: 3,
      last_error: null,
      wireguard: null,
      wireguard_status: null,
      wireguard_public_key: null,
      wireguard_enrolled: false,
    } satisfies GatewayEntry;
    stubFetch(200, [wire]);
    const list = await liveApi.listGateways();
    const entry: GatewayEntry = list[0];
    expect(entry).toEqual(wire);
    expect(entry.wireguard).toBeNull();
    expect(entry.wireguard_status).toBeNull();
    expect(entry.wireguard_public_key).toBeNull();
    expect(entry.wireguard_enrolled).toBe(false);
  });

  it("parses a row's generated WireGuard key and its enrollment", async () => {
    const row = {
      id: "gw-1a2b3c4d",
      url: "https://gw.chan.app",
      label: "",
      enabled: true,
      status: "connected",
      pending_signin: false,
      devserver_count: 1,
      last_error: null,
      wireguard: "/home/u/.chan/desktop/wireguard/gw-1a2b3c4d.conf",
      wireguard_status: "up",
      wireguard_public_key: "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=",
      wireguard_enrolled: true,
    } satisfies GatewayEntry;
    stubFetch(200, [row]);
    const [entry] = await liveApi.listGateways();
    expect(entry.wireguard_public_key).toBe("xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=");
    expect(entry.wireguard_enrolled).toBe(true);
  });

  it("parses WireGuard gateway rows: the stored path, the live status, a refusal reason", async () => {
    const row = {
      id: "gw-1a2b3c4d",
      url: "https://gw.chan.app",
      label: "prod",
      enabled: true,
      status: "disconnected",
      pending_signin: false,
      devserver_count: 0,
      last_error: null,
      wireguard: "/home/u/wg/chan.conf",
      wireguard_status: "up",
    } satisfies GatewayEntry;
    const refused = {
      ...row,
      id: "gw-5e6f7a8b",
      url: "https://other.chan.app",
      last_error: "WireGuard: /home/u/wg/other.conf: line 3: Address: not an IP address",
      wireguard: "/home/u/wg/other.conf",
      wireguard_status: null,
    } satisfies GatewayEntry;
    stubFetch(200, [row, refused]);
    const [running, failed] = await liveApi.listGateways();
    expect(running.wireguard).toBe("/home/u/wg/chan.conf");
    expect(running.wireguard_status).toBe("up");
    expect(failed.wireguard_status).toBeNull();
    expect(failed.last_error).toMatch(/^WireGuard: /);
  });

  it("uses guarded PUT and DELETE routes for exact synthesized-row trust", async () => {
    const id = `gw:feedface:bob:${"d".repeat(64)}`;
    const { calls } = stubFetch(204);
    await liveApi.grantDevserverNativeTrust(id);
    await liveApi.revokeDevserverNativeTrust(id);

    const path = `/api/library/devservers/${encodeURIComponent(id)}/native-trust`;
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      [path, "PUT"],
      [path, "DELETE"],
    ]);
  });
});

describe("mock gateway registry", () => {
  afterEach(() => {
    resetMockGateways();
  });

  it("starts empty; add/connect/disconnect/remove round-trip", async () => {
    expect(await mockApi.listGateways()).toEqual([]);
    const gw = await mockApi.addGateway({ url: "https://gw.example" });
    expect(gw.enabled).toBe(true);
    expect(gw.status).toBe("disconnected");

    await mockApi.connectGateway(gw.id);
    expect((await mockApi.listGateways())[0].status).toBe("connected");

    await mockApi.disconnectGateway(gw.id);
    const after = (await mockApi.listGateways())[0];
    expect(after.status).toBe("disconnected");
    expect(after.enabled).toBe(false);

    await mockApi.removeGateway(gw.id);
    expect(await mockApi.listGateways()).toEqual([]);
  });

  it("update renames in place and leaves the URL untouched", async () => {
    const gw = await mockApi.addGateway({ url: "https://gw.example", label: "old" });
    const renamed = await mockApi.updateGateway(gw.id, {
      url: "https://gw.example",
      label: "  new  ",
    });
    expect(renamed.id).toBe(gw.id);
    expect(renamed.label).toBe("new");
    expect(renamed.url).toBe("https://gw.example");
    expect((await mockApi.listGateways())[0].label).toBe("new");
    // The mock guards throw synchronously (like updateDevserver's).
    expect(() => mockApi.updateGateway("gw-ghost", { url: "https://gw.example" })).toThrow(
      /unknown gateway/,
    );
  });

  it("stores the WireGuard file, runs it at once, and clears on a blank update", async () => {
    const gw = await mockApi.addGateway({ url: "https://gw.example", wireguard: " ~/.config/chan/gateway.conf " });
    expect(gw.wireguard).toBe("~/.config/chan/gateway.conf");
    expect(gw.wireguard_status, "a file on a new row runs at once").toBe("connecting");
    const direct = await mockApi.addGateway({ url: "https://direct.example", wireguard: "" });
    expect(direct.wireguard).toBeNull();
    expect(direct.wireguard_status).toBeNull();
    const cleared = await mockApi.updateGateway(gw.id, { url: gw.url });
    expect(cleared.wireguard).toBeNull();
    expect(cleared.wireguard_status).toBeNull();
    expect((await mockApi.listGateways()).find((g) => g.id === gw.id)!.wireguard).toBeNull();
  });

  it("generates a key, refuses a gateway that enrolls no peers, and enrolls at connect", async () => {
    const gw = await mockApi.addGateway({ url: "https://gw.example" });
    const keyed = await mockApi.generateWireguardKey(gw.id);
    expect(keyed.wireguard_public_key).toHaveLength(44);
    expect(keyed.wireguard_enrolled).toBe(false);
    const again = await mockApi.generateWireguardKey(gw.id);
    expect(again.wireguard_public_key).not.toBe(keyed.wireguard_public_key);
    await mockApi.connectGateway(gw.id);
    let row = (await mockApi.listGateways()).find((g) => g.id === gw.id)!;
    expect(row.wireguard_enrolled).toBe(true);
    expect(row.wireguard).toBe(`~/.chan/desktop/wireguard/${gw.id}.conf`);
    expect(row.wireguard_status).toBe("connecting");
    // Clearing the file drops the enrollment and keeps the key.
    const cleared = await mockApi.updateGateway(gw.id, { url: gw.url });
    expect(cleared.wireguard_enrolled).toBe(false);
    expect(cleared.wireguard_public_key).toBe(again.wireguard_public_key);
    row = (await mockApi.listGateways()).find((g) => g.id === gw.id)!;
    expect(row.wireguard).toBeNull();
    const direct = await mockApi.addGateway({ url: "https://direct.example" });
    let caught: unknown = null;
    try {
      mockApi.generateWireguardKey(direct.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("this gateway does not enroll WireGuard peers");
  });

  it("serves the WireGuard key fields on an added gateway", async () => {
    const gw = await mockApi.addGateway({ url: "https://gw.example", wireguard: "/w/gw.conf" });
    expect(gw.wireguard_public_key).toBeNull();
    expect(gw.wireguard_enrolled).toBe(false);
    const listed = (await mockApi.listGateways()).find((g) => g.id === gw.id)!;
    expect(listed.wireguard_public_key).toBeNull();
    expect(listed.wireguard_enrolled).toBe(false);
  });

  it("refuses a relative WireGuard path with the registry's 400 sentence", () => {
    let caught: unknown = null;
    try {
      mockApi.addGateway({ url: "https://gw.example", wireguard: "wg/chan.conf" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    expect((caught as ApiError).message).toBe("WireGuard: the file path must be absolute: wg/chan.conf");
  });

  it("notifies watch subscribers on gateway mutations", async () => {
    let pushes = 0;
    const unsub = mockApi.watchWindows(() => {
      pushes += 1;
    });
    const seen = pushes; // the on-connect snapshot
    const gw = await mockApi.addGateway({ url: "https://gw.example" });
    await mockApi.removeGateway(gw.id);
    expect(pushes).toBeGreaterThan(seen);
    unsub();
  });
});

describe("demo gateway registry", () => {
  it("the populated variant fabricates one sample gateway", async () => {
    const demo = createLauncherDemoApi();
    const gateways = await demo.listGateways();
    expect(gateways).toHaveLength(1);
    expect(gateways[0].status).toBe("connected");
  });

  it("the empty variant seeds none", async () => {
    const demo = createLauncherDemoApi({ variant: "empty" });
    expect(await demo.listGateways()).toEqual([]);
  });

  it("generates a key that the next connect enrolls", async () => {
    const demo = createLauncherDemoApi({ variant: "empty" });
    const gw = await demo.addGateway({ url: "https://gw.example" });
    const keyed = await demo.generateWireguardKey(gw.id);
    expect(keyed.wireguard_public_key).toHaveLength(44);
    expect(keyed.wireguard_enrolled).toBe(false);
    await demo.connectGateway(gw.id);
    const [row] = await demo.listGateways();
    expect(row.wireguard_enrolled).toBe(true);
  });

  it("serves the WireGuard key fields on the sample and on an added gateway", async () => {
    const demo = createLauncherDemoApi();
    const [sample] = await demo.listGateways();
    expect(sample.wireguard_public_key).toBeNull();
    expect(sample.wireguard_enrolled).toBe(false);
    const added = await demo.addGateway({ url: "https://gw.example" });
    expect(added.wireguard_public_key).toBeNull();
    expect(added.wireguard_enrolled).toBe(false);
  });
});
