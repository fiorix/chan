// The ghostty widget's own wasm, for tests that load ghostty-web's core
// through the widget's loader rather than chan's vendored binding.

import { readFileSync } from "node:fs";

/// The widget's wasm as a data URL, for `Ghostty.load(url)`. Called with no
/// argument, the loader names the file as `new URL("../ghostty-vt.wasm",
/// import.meta.url)`, which vitest's jsdom environment rewrites to a URL on a
/// dev server that is not running, so the load fails. A data URL is fetched in
/// place. Vitest runs in the package directory, which the path is relative
/// to.
export function ghosttyWidgetWasmUrl(): string {
  const bytes = readFileSync("../ghostty-web-ng/ghostty-vt.wasm");
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `data:application/wasm;base64,${btoa(binary)}`;
}
