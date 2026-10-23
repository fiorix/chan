// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";

class Socket extends EventTarget {
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen = null;
  onmessage = null;
  onerror = null;
  closed = false;
  close(): void { this.closed = true; }
  remoteClose(code: number): void {
    const event = new CloseEvent("close", { code });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

beforeEach(() => {
  vi.resetModules();
  window.history.replaceState(null, "", "/?h=home");
  sessionStorage.clear();
});

test("every transport carries the same client claim", async () => {
  const transport = await import("./transport");
  const urls: string[] = [];
  transport.setSocketFactory((url) => { urls.push(url); return new Socket() as unknown as WebSocket; });
  transport.createSocket("ws://localhost/ws?w=w1");
  transport.createSocket("ws://localhost/api/terminal/ws?session=pty1");
  transport.createSocket("ws://localhost/api/doc/ws?path=notes.md&w=w1");
  expect(urls.map((url) => new URL(url).searchParams.getAll("h"))).toEqual([["home"], ["home"], ["home"]]);
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
  transport.setFetchImpl(fetch);
  await transport.chanFetch("/api/session", { method: "PUT" });
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-chan-holder")).toBe("home");
});

test("detach closes every local connection, suppresses retries and writes, and permits explicit resume", async () => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  const sockets: Socket[] = [];
  transport.setSocketFactory(() => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; });
  const events = transport.createSocket("ws://localhost/ws?w=w1");
  const terminal = transport.createSocket("ws://localhost/api/terminal/ws");
  const reconnect = vi.fn();
  events.onclose = reconnect;
  terminal.onclose = reconnect;
  sockets[0].remoteClose(4001);
  expect(session.clientDetached()).toBe(true);
  expect(sockets.every((s) => s.closed)).toBe(true);
  expect(reconnect).not.toHaveBeenCalled();
  expect(() => transport.createSocket("ws://localhost/ws")).toThrow("detached");
  expect(() => transport.createXhr()).toThrow("detached");
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  transport.setFetchImpl(fetch);
  await expect(transport.chanFetch("/api/session", { method: "PUT" })).rejects.toThrow("detached");
  expect(fetch).not.toHaveBeenCalled();
  await transport.chanFetch("/api/session/resume", { method: "POST" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("detach aborts a running upload and tags it for server admission", async () => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  const { api } = await import("./client");
  const headers: Record<string, string> = {};
  const xhr = {
    open: vi.fn(),
    send: vi.fn(),
    setRequestHeader: (key: string, value: string) => { headers[key] = value; },
    upload: {},
    onabort: null as (() => void) | null,
    onloadend: null as (() => void) | null,
    abort: vi.fn(() => { xhr.onabort?.(); xhr.onloadend?.(); }),
  };
  transport.setXhrFactory(() => xhr as unknown as XMLHttpRequest);
  const upload = api.uploadFile(new File(["x"], "note.txt"), "inbox");
  const rejected = expect(upload).rejects.toThrow();
  await vi.waitFor(() => expect(xhr.send).toHaveBeenCalledOnce());
  expect(headers["x-chan-holder"]).toBe("home");
  session.markClientDetached();
  await rejected;
  expect(xhr.abort).toHaveBeenCalledOnce();
});

test("a network close keeps reconnect enabled", async () => {
  const transport = await import("./transport");
  const session = await import("./clientSession");
  const socket = new Socket();
  transport.setSocketFactory(() => socket as unknown as WebSocket);
  transport.createSocket("ws://localhost/ws");
  const reconnect = vi.fn();
  socket.onclose = reconnect;
  socket.remoteClose(1006);
  expect(session.clientDetached()).toBe(false);
  expect(reconnect).toHaveBeenCalledOnce();
});

test("a directly opened browser tab retains its identity across reloads", async () => {
  window.history.replaceState(null, "", "/?w=direct");
  const first = (await import("./clientSession")).clientHolder();
  vi.resetModules();
  expect((await import("./clientSession")).clientHolder()).toBe(first);
});
