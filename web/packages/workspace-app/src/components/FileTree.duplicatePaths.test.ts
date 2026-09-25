import { describe, expect, test } from "vitest";
import fileTree from "./FileTree.svelte?raw";

describe("FileTree duplicate path guard", () => {
  test("buildTree tracks seen paths before inserting keyed rows", () => {
    expect(fileTree).toMatch(/const seen = new Set<string>\(\);/);
    expect(fileTree).toMatch(/if \(seen\.has\(e\.path\)\) continue;/);
    expect(fileTree).toMatch(/seen\.add\(e\.path\);/);
  });

  test("explicit directory entries do not duplicate placeholder parents", () => {
    expect(fileTree).toMatch(/if \(e\.is_dir\) \{[\s\S]{1,120}if \(dirs\.has\(e\.path\)\) continue;/);
  });
});
