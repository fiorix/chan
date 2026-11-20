import { describe, expect, test } from "vitest";

import { classifyTerminalLink, needsServerHost, resolveTerminalPath } from "./linkTarget";

// gethostname can answer in mixed case; a URL's host is lower case.
const HOST = "Build-Box";

describe("classifyTerminalLink", () => {
  test("a URL the browser opens is a web link", () => {
    expect(classifyTerminalLink("https://example.com/a?b=c#d", HOST)).toEqual({
      kind: "web",
      url: "https://example.com/a?b=c#d",
      refusal: null,
    });
  });

  test("a scheme the external-open gate refuses is a web link it names", () => {
    expect(classifyTerminalLink("ssh://git@example.com/repo", HOST)).toEqual({
      kind: "web",
      url: "ssh://git@example.com/repo",
      refusal: "ssh: links do not open in a browser",
    });
  });

  test.each([
    ["no host", "file:///srv/notes%20today.md"],
    ["localhost", "file://localhost/srv/notes%20today.md"],
    ["the server's host name", "file://Build-Box/srv/notes%20today.md"],
  ])("a file URI with %s is a path on this host", (_, uri) => {
    expect(classifyTerminalLink(uri, HOST)).toEqual({
      kind: "file",
      path: "/srv/notes today.md",
      relative: false,
      refusal: null,
    });
  });

  test("a file URI naming another host is refused with that host", () => {
    expect(classifyTerminalLink("file://elsewhere/srv/notes.md", HOST)).toEqual({
      kind: "file",
      path: "/srv/notes.md",
      relative: false,
      refusal: "on another host (elsewhere)",
    });
    expect(needsServerHost("file://elsewhere/srv/notes.md")).toBe(true);
    expect(needsServerHost("file:///srv/notes.md")).toBe(false);
    expect(needsServerHost("file://localhost/srv/notes.md")).toBe(false);
  });

  test("a bare path is a file link, relative unless it starts at the root or the home", () => {
    expect(classifyTerminalLink("/etc/hosts", HOST)).toEqual({
      kind: "file",
      path: "/etc/hosts",
      relative: false,
      refusal: null,
    });
    expect(classifyTerminalLink("~/notes/today.md", HOST)).toEqual({
      kind: "file",
      path: "~/notes/today.md",
      relative: false,
      refusal: null,
    });
    expect(classifyTerminalLink("~other/today.md", HOST)).toMatchObject({ relative: true });
    expect(classifyTerminalLink("./dev/notes.md:12", HOST)).toEqual({
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
