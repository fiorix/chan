import { describe, expect, test } from "vitest";
import source from "./HybridFileBrowserConfig.svelte?raw";
import shell from "./HybridSurfaceConfigShell.svelte?raw";
import excludedDirs from "./settings/workspace/ExcludedDirsControl.svelte?raw";

describe("HybridFileBrowserConfig back card", () => {
  test("it is shell-only and routes OK through onDone", () => {
    expect(source).toMatch(
      /let \{ onDone \}: \{ onDone\?: \(\) => void \} = \$props\(\)/,
    );
    expect(source).toMatch(
      /<HybridSurfaceConfigShell[\s\S]{1,120}title="Hybrid File Browser"[\s\S]{1,160}\{onDone\}[\s\S]{1,20}\/>/,
    );
    expect(shell).toMatch(
      /<button type="button" class="config-ok" onclick=\{\(\) => onDone\?\.\(\)\}>OK<\/button>/,
    );
  });

  test("moved workspace controls no longer render or save from the card", () => {
    expect(source).not.toMatch(/<h3>Excluded directories<\/h3>/);
    expect(source).not.toMatch(/api\.excludedDirs\(\)/);
    expect(source).not.toMatch(/api\.setExcludedDirs\(/);
    expect(source).not.toMatch(/list="excluded-dir-suggestions"/);
    expect(source).not.toMatch(/function normalizeName/);
  });
});

describe("Settings owns excluded directories", () => {
  test("This workspace tab carries the GET/PUT blocklist editor", () => {
    expect(excludedDirs).toMatch(/<SettingField[\s\S]{0,80}label="Excluded directories"/);
    expect(excludedDirs).toMatch(/api\.excludedDirs\(\)/);
    expect(excludedDirs).toMatch(/api\.setExcludedDirs\(/);
    expect(excludedDirs).toMatch(/list="settings-excluded-dir-suggestions"/);
    expect(excludedDirs).toMatch(/function normalizeName/);
  });
});
