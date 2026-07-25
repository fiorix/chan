// @vitest-environment jsdom

// The multipart upload helpers ride XHR (for upload progress), which the
// chanFetch seam does not cover, so the gateway CSRF mirror must be applied
// on the XHR itself: through a gateway-proxied devserver a POST without the
// `__Host-devserver_csrf` cookie mirrored into `x-chan-csrf` is 403'd before the
// tunnel. These tests pin that both helpers mirror the cookie when it is
// present and stay header-free on loopback (no cookie).

import { afterEach, describe, expect, test } from "vitest";
import { api } from "./client";
import { setXhrFactory } from "./transport";

/// Minimal XHR stand-in: records the request headers the helpers set and
/// answers every send with a 200 upload response so the promise resolves.
class FakeXhr {
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
    this.status = 200;
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

function installFakeXhr(): FakeXhr[] {
  const created: FakeXhr[] = [];
  setXhrFactory(() => {
    const xhr = new FakeXhr();
    created.push(xhr);
    return xhr as unknown as XMLHttpRequest;
  });
  return created;
}

afterEach(() => {
  setXhrFactory(null);
  // `Secure` is required: the `__Host-` prefix mandates it, and jsdom's cookie
  // jar rejects a `__Host-` cookie set without it, so the read would see nothing.
  document.cookie = "__Host-devserver_csrf=; Max-Age=0; path=/; Secure";
});

describe("XHR multipart gateway CSRF mirror", () => {
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
