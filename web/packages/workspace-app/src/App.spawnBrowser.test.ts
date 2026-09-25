import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import store from "../state/store.svelte.ts?raw";

// Spawning a File Browser opens it AT its directory target rather than
// highlighting that directory under a collapsed root.
//
// This matters most on a standalone terminal window, whose capability root is
// the whole machine: `revealAndSelect` expands ancestors only, so the browser
// rendered `/` with `$HOME` selected somewhere below it and the user had to
// walk down to the directory they had just asked for. The fresh-Files-window
// boot already fixed this for itself by entering the path; the spawn path
// kept selecting.
describe("File Browser spawn enters its directory", () => {
  test("a directory target is entered, a file target is selected", () => {
    // The directory branch must use the entering reveal...
    expect(app).toMatch(
      /revealPathInBrowser\(dir, \{[\s\S]{0,200}enter: true,/,
    );
    // ...and must be reached only when the context named no file, so
    // "reveal this file" keeps selecting inside its parent.
    expect(app).toMatch(/ctx\.file === undefined/);
    // The file branch still selects.
    expect(app).toMatch(/if \(select\) revealAndSelect\(select\);/);
  });

  test("a standalone window falls back to the tenant's home, not its root", () => {
    // `rootless` is the standalone context's homeWire; a workspace window
    // passes null and keeps landing on its own root.
    expect(app).toMatch(
      /const rootless = windowCaps\.workspace \? null : \(filesContext\.current\?\.homeWire \?\? null\);/,
    );
    expect(app).toMatch(/const dir = ctx\.dir \|\| rootless;/);
  });

  test("entering expands the directory itself, not only its ancestors", () => {
    // The distinction the bug turned on: `revealPathInBrowser` walks to
    // `parts.length` when entering and `parts.length - 1` otherwise, while
    // `revealAndSelect` only ever does ancestors.
    expect(store).toMatch(
      /const upto = opts\.enter \? parts\.length : parts\.length - 1;/,
    );
    expect(store).toMatch(
      /export function revealAndSelect\(path: string\): void \{[\s\S]{0,400}parts\.length - 1/,
    );
  });
});
