// @vitest-environment jsdom

// The multipart upload helpers ride XHR (for upload progress), which the
// chanFetch seam does not cover, so the gateway CSRF mirror must be applied
// on the XHR itself: through a gateway-proxied devserver a POST without the
// `__Host-devserver_csrf` cookie mirrored into `x-chan-csrf` is 403'd before the
// tunnel. These tests pin the native-then-cookie source order, the one-shot
// desktop retry, and the header-free loopback path.

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./client";
import { setGatewayCsrfTokenReader, setXhrFactory } from "./transport";

/// Minimal XHR stand-in: records the request headers and answers each send with
/// its configured status.
class FakeXhr {
  constructor(private readonly responseStatus = 200) {}

  headers: Record<string, string> = {};
  body: Document | XMLHttpRequestBodyInit | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: Document | XMLHttpRequestBodyInit | null = null): void {
    this.body = body;
    this.status = this.responseStatus;
    this.responseText = JSON.stringify({ path: "a.txt", size: 1 });
    queueMicrotask(() => {
      this.onload?.();
      this.onloadend?.();
    });
  }
  abort(): void {
    queueMicrotask(() => this.onabort?.());
  }
}

function installFakeXhr(statuses: number[] = [200]): FakeXhr[] {
  const created: FakeXhr[] = [];
  setXhrFactory(() => {
    const xhr = new FakeXhr(statuses[created.length] ?? statuses.at(-1) ?? 200);
    created.push(xhr);
    return xhr as unknown as XMLHttpRequest;
  });
  return created;
}

afterEach(() => {
  setXhrFactory(null);
  setGatewayCsrfTokenReader(null);
  // `Secure` is required: the `__Host-` prefix mandates it, and jsdom's cookie
  // jar rejects a `__Host-` cookie set without it, so the read would see nothing.
  document.cookie = "__Host-devserver_csrf=; Max-Age=0; path=/; Secure";
});

describe("XHR multipart gateway CSRF mirror", () => {
  test("prefers the desktop token over the readable cookie", async () => {
    document.cookie = "__Host-devserver_csrf=cookie-token; path=/; Secure";
    setGatewayCsrfTokenReader(async () => "desktop-token");
    const created = installFakeXhr();

    await api.uploadFile(new File(["x"], "a.txt"), "inbox");

    expect(created[0].headers["x-chan-csrf"]).toBe("desktop-token");
  });

  test("re-reads the desktop token and retries one 403 exactly once", async () => {
    const readToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("csrf-old")
      .mockResolvedValue("csrf-fresh");
    setGatewayCsrfTokenReader(readToken);
    const created = installFakeXhr([403, 403, 200]);

    await expect(
      api.uploadFile(new File(["x"], "a.txt"), "inbox"),
    ).rejects.toMatchObject({ status: 403 });

    expect(readToken).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
    expect(created.map((xhr) => xhr.headers["x-chan-csrf"])).toEqual([
      "csrf-old",
      "csrf-fresh",
    ]);
  });

  test("uploadFile mirrors the __Host-devserver_csrf cookie into x-chan-csrf", async () => {
    document.cookie = "__Host-devserver_csrf=csrf-token; path=/; Secure";
    const created = installFakeXhr();

    await api.uploadFile(new File(["x"], "a.txt"), "inbox");

    expect(created).toHaveLength(1);
    expect(created[0].headers["x-chan-csrf"]).toBe("csrf-token");
  });

  test("replaceFile mirrors the __Host-devserver_csrf cookie into x-chan-csrf", async () => {
    document.cookie = "__Host-devserver_csrf=csrf-token; path=/; Secure";
    const created = installFakeXhr();

    await api.replaceFile(new File(["x"], "a.txt"), "inbox/a.txt");

    expect(created).toHaveLength(1);
    expect(created[0].headers["x-chan-csrf"]).toBe("csrf-token");
  });

  test("destination metadata precedes the streaming file part", async () => {
    const created = installFakeXhr();

    await api.uploadFile(new File(["x"], "a.txt"), "inbox");
    await api.replaceFile(new File(["x"], "a.txt"), "inbox/a.txt");

    expect(Array.from((created[0].body as FormData).keys())).toEqual(["dir", "file"]);
    expect(Array.from((created[1].body as FormData).keys())).toEqual(["path", "file"]);
  });

  test("uploadFile sends no csrf header without the cookie (loopback)", async () => {
    const created = installFakeXhr();

    await api.uploadFile(new File(["x"], "a.txt"), "inbox");

    expect(created).toHaveLength(1);
    expect(created[0].headers["x-chan-csrf"]).toBeUndefined();
  });

  test("replaceFile sends no csrf header without the cookie (loopback)", async () => {
    const created = installFakeXhr();

    await api.replaceFile(new File(["x"], "a.txt"), "inbox/a.txt");

    expect(created).toHaveLength(1);
    expect(created[0].headers["x-chan-csrf"]).toBeUndefined();
  });
});
