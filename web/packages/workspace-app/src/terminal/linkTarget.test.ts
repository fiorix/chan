import { describe, expect, test, vi } from "vitest";

import { classifyTerminalLink, middleEllipsis, resolveTerminalPath } from "./linkTarget";

// gethostname can answer in mixed case; a URL's host is lower case.
const HOST = "Build-Box";
const serverHost = () => Promise.resolve(HOST);

describe("classifyTerminalLink", () => {
  test("a URL the browser opens is a web link, with the host it names", async () => {
    expect(await classifyTerminalLink("https://example.com/a?b=c#d", serverHost)).toEqual({
      kind: "web",
      url: "https://example.com/a?b=c#d",
      host: "example.com",
      refusal: null,
    });
    // The text before `@` is a user name; the host is what follows.
    expect(await classifyTerminalLink("https://github.com@evil.example/x", serverHost)).toMatchObject({
      host: "evil.example",
    });
    // A port the browser would contact is part of the host it shows.
    expect(await classifyTerminalLink("https://example.com:8443/a", serverHost)).toMatchObject({
      host: "example.com:8443",
    });
    // An international name shows as the browser contacts it, in punycode.
    expect(await classifyTerminalLink("https://\u4f8b\u3048.jp/", serverHost)).toMatchObject({
      host: "xn--r8jz45g.jp",
    });
  });

  test("a scheme the external-open gate refuses is a web link it names", async () => {
    expect(await classifyTerminalLink("ssh://git@example.com/repo", serverHost)).toEqual({
      kind: "web",
      url: "ssh://git@example.com/repo",
      host: "example.com",
      refusal: "ssh: links do not open in a browser",
    });
  });

  test.each([
    ["no host", "file:///srv/notes%20today.md"],
    ["localhost", "file://localhost/srv/notes%20today.md"],
    ["the server's host name", "file://Build-Box/srv/notes%20today.md"],
  ])("a file URI with %s is a path on this host", async (_, uri) => {
    expect(await classifyTerminalLink(uri, serverHost)).toEqual({
      kind: "file",
      path: "/srv/notes today.md",
      relative: false,
      refusal: null,
    });
  });

  test("a file URI naming another host is refused with that host, asking the server's name only then", async () => {
    const asked = vi.fn(serverHost);
    expect(await classifyTerminalLink("file://elsewhere/srv/notes.md", asked)).toEqual({
      kind: "file",
      path: "/srv/notes.md",
      relative: false,
      refusal: "on another host (elsewhere)",
    });
    expect(asked).toHaveBeenCalledTimes(1);
    await classifyTerminalLink("file:///srv/notes.md", asked);
    await classifyTerminalLink("file://localhost/srv/notes.md", asked);
    await classifyTerminalLink("https://example.com/", asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  test("a bare path is a file link, relative unless it starts at the root or the home", async () => {
    expect(await classifyTerminalLink("/etc/hosts", serverHost)).toEqual({
      kind: "file",
      path: "/etc/hosts",
      relative: false,
      refusal: null,
    });
    expect(await classifyTerminalLink("~/notes/today.md", serverHost)).toEqual({
      kind: "file",
      path: "~/notes/today.md",
      relative: false,
      refusal: null,
    });
    expect(await classifyTerminalLink("~other/today.md", serverHost)).toMatchObject({ relative: true });
    expect(await classifyTerminalLink("./dev/notes.md:12", serverHost)).toEqual({
      kind: "file",
      path: "./dev/notes.md:12",
      relative: true,
      refusal: null,
    });
  });
});

describe("resolveTerminalPath", () => {
  test("a relative path resolves against the shell's directory", () => {
    expect(resolveTerminalPath("./dev/../docs/notes.md", "/home/me/repo/")).toBe("/home/me/repo/docs/notes.md");
    expect(resolveTerminalPath("/etc/./hosts", "/home/me")).toBe("/etc/hosts");
  });
});

describe("middleEllipsis", () => {
  test("a long target keeps both ends", () => {
    expect(middleEllipsis("short", 10)).toBe("short");
    expect(middleEllipsis("https://trusted.example/aaaaaaaa@evil.example", 21)).toBe(
      "https://tr\u2026il.example",
    );
    // An odd number of kept characters gives the head the extra one.
    expect(middleEllipsis("abcdefghijklmnop", 10)).toBe("abcde\u2026mnop");
  });
});
