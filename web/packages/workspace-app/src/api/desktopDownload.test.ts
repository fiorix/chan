// Pin the desktop download capability's shape so the contract
// the inspector Download button relies on stays stable. Source
// asserts (`?raw`) mirror the repo's other capability-shape tests.

import { describe, expect, test } from "vitest";
import desktop from "./desktop.ts?raw";

describe("desktop download capability", () => {
  test("runDesktopDownload delegates same-origin streaming to Rust", () => {
    expect(desktop).toContain("export async function runDesktopDownload(");
    expect(desktop).toContain('"download_file_native"');
    expect(desktop).toContain('"native_transfer_status"');
    expect(desktop).toContain("status.loaded / status.total");
    expect(desktop).not.toContain('responseType = "arraybuffer"');
    expect(desktop).not.toContain("Array.from(bytes)");
  });

  test("it gates on isTauriDesktop and drives the unified transfer model", () => {
    expect(desktop).toContain('runDesktopDownload called outside chan-desktop');
    // The transfer bubble is the single download surface (the old per-flow
    // downloadTransfer store is retired).
    expect(desktop).toContain("beginTransfer({");
    expect(desktop).toContain("finishTransfer(xferId, saved.path)");
    expect(desktop).toContain("failTransfer(xferId, message)");
    expect(desktop).toContain('"cancel_native_transfer"');
  });
});
