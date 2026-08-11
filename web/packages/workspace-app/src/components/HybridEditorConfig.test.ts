import { describe, expect, test } from "vitest";
import source from "./HybridEditorConfig.svelte?raw";
import shell from "./HybridSurfaceConfigShell.svelte?raw";
import surfaceThemeFieldSource from "./settings/SurfaceThemeField.svelte?raw";
import editorSource from "./settings/EditorSection.svelte?raw";

describe("HybridEditorConfig back card", () => {
  test("it is shell-only and routes OK through onDone", () => {
    expect(source).toMatch(
      /let \{ onDone \}: \{ onDone\?: \(\) => void \} = \$props\(\)/,
    );
    expect(source).toMatch(
      /<HybridSurfaceConfigShell title="Hybrid Editor" \{onDone\} \/>/,
    );
    expect(shell).toMatch(
      /<button type="button" class="config-ok" onclick=\{\(\) => onDone\?\.\(\)\}>OK<\/button>/,
    );
  });

  test("moved editor controls no longer render or save from the card", () => {
    expect(source).not.toMatch(/name="hybrid-editor-theme"/);
    expect(source).not.toMatch(/name="hybrid-line-spacing"/);
    expect(source).not.toMatch(/DATE_FORMATS/);
    expect(source).not.toMatch(/strip_trailing_whitespace_on_save/);
    expect(source).not.toMatch(/updateGlobalConfigSerial/);
    expect(source).not.toMatch(/api\./);
  });
});

describe("Settings owns editor controls", () => {
  test("Editor section owns editor theme, line spacing, and surface body theme", () => {
    expect(editorSource).toMatch(/name="settings-editor-theme"/);
    expect(editorSource).toMatch(/name="settings-line-spacing"/);
    expect(editorSource).toMatch(/<SurfaceThemeField kind="editor"/);
    expect(surfaceThemeFieldSource).toMatch(/setHybridSurfaceTheme\(/);
    expect(surfaceThemeFieldSource).toMatch(/clearHybridSurfaceTheme\(/);
  });

  test("Editor section owns date format and strip-on-save", () => {
    expect(editorSource).toMatch(/\{#each DATE_FORMATS as f \(f\.id\)\}/);
    expect(editorSource).toMatch(/date_format: e\.currentTarget\.value/);
    expect(editorSource).toMatch(/strip_trailing_whitespace_on_save: on/);
  });
});
