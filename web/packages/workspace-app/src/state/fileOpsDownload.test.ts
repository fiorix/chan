// @vitest-environment jsdom
//
// The inspector Download button routes through
// fileOps.downloadPathWithProgress, which branches on isTauriDesktop():
//   - desktop -> runDesktopDownload (progress-tracked, shown in the
//                transfer bubble),
//   - browser -> the existing <a download> hand-off to the native
//                download manager.
// These tests pin that branch so the desktop integration can't silently
// regress to the browser-only path.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the desktop capability before the store module evaluates so the
// import binding fileOps reads is the mock.
const isTauriDesktop = vi.fn<() => boolean>();
const runDesktopDownload = vi.fn<(url: string, name: string) => Promise<string>>();

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => isTauriDesktop(),
  runDesktopDownload: (url: string, name: string) =>
    runDesktopDownload(url, name),
}));

let fileOps: typeof import("./store.svelte").fileOps;

beforeEach(async () => {
  vi.resetAllMocks();
  runDesktopDownload.mockResolvedValue("/Users/me/Downloads/note.md");
  ({ fileOps } = await import("./store.svelte"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fileOps.downloadPathWithProgress branch", () => {
  test("desktop routes through runDesktopDownload with a resolved URL", () => {
    isTauriDesktop.mockReturnValue(true);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    fileOps.downloadPathWithProgress("notes/note.md", false);

    expect(runDesktopDownload).toHaveBeenCalledTimes(1);
    const [url, filename] = runDesktopDownload.mock.calls[0]!;
    // Absolute (resolved against window.location), and the suggested
    // name is the basename (downloadFilename for a file).
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain("/api/fs/");
    expect(filename).toBe("note.md");
    // The browser <a download> path must NOT fire on desktop.
    expect(click).not.toHaveBeenCalled();
  });

  test("desktop directory download suggests the .tar archive name", () => {
    isTauriDesktop.mockReturnValue(true);

    fileOps.downloadPathWithProgress("notes", true);

    expect(runDesktopDownload).toHaveBeenCalledTimes(1);
    const [, filename] = runDesktopDownload.mock.calls[0]!;
    expect(filename).toBe("notes.tar");
  });

  test("filesystem-root download carries the typed root marker", () => {
    isTauriDesktop.mockReturnValue(true);

    fileOps.downloadPathWithProgress("tmp/build.bin", false, "filesystem");

    const [url] = runDesktopDownload.mock.calls[0]!;
    expect(url).toContain("/api/fs/tmp/build.bin?download=1&root=filesystem");
  });

  test("browser falls back to the <a download> manager", () => {
    isTauriDesktop.mockReturnValue(false);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");

    fileOps.downloadPathWithProgress("notes/note.md", false);

    expect(runDesktopDownload).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });
});
