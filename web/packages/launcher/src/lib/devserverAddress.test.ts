import { describe, expect, it } from "vitest";
import { parseAddress, validPort } from "./devserverAddress";

describe("parseAddress", () => {
  it("reads a bare host:port", () => {
    expect(parseAddress(" 127.0.0.1:8787 ")).toEqual({
      url: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("reads a full URL, defaults its port by scheme and lifts the token", () => {
    const parsed = parseAddress("https://box.example.com?t=secret");
    expect(parsed?.host).toBe("box.example.com");
    expect(parsed?.port).toBe(443);
    expect(parsed?.token).toBe("secret");
    expect(parsed?.url).toBe("https://box.example.com/");
  });

  it("reads an empty ?t= as a request to clear the token", () => {
    expect(parseAddress("http://box:9000?t=")?.token).toBe("");
  });

  it("keeps a bracketed IPv6 host", () => {
    expect(parseAddress("[::1]:8787")).toMatchObject({ host: "[::1]", port: 8787 });
  });

  it("flags a missing or malformed port for the caller to reject", () => {
    expect(parseAddress("box")?.port).toBeNull();
    expect(parseAddress("box:")?.port).toBeNull();
    expect(parseAddress("box:abc")?.port).toBeNull();
    expect(parseAddress("bad host:80")).toEqual({ url: "", host: "", port: null });
  });

  it("returns null for blank input", () => {
    expect(parseAddress("   ")).toBeNull();
  });
});

describe("validPort", () => {
  it("accepts 1..65535 only", () => {
    expect(validPort(1)).toBe(true);
    expect(validPort(65535)).toBe(true);
    expect(validPort(0)).toBe(false);
    expect(validPort(65536)).toBe(false);
    expect(validPort(null)).toBe(false);
  });
});
