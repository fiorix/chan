import { describe, expect, test } from "vitest";
import fileInfo from "./FileInfoBody.svelte?raw";

describe("FileInfoBody audio preview", () => {
  test("audio joins media routing without changing the file kind", () => {
    expect(fileInfo).toMatch(
      /import \{\s*isAudio,[^}]*\}\s*from "\.\.\/state\/fileTypes";/,
    );
    expect(fileInfo).toMatch(/const audio = !isDir && isAudio\(p\);/);
    expect(fileInfo).toMatch(/const media = image \|\| pdf \|\| video \|\| audio;/);
    expect(fileInfo).toMatch(/"View Audio"[\s\S]{1,220}openMediaViewer\(p\)/);
  });

  test("renders a non-autoplaying tokenized native player", () => {
    const start = fileInfo.indexOf("{:else if audio}");
    const end = fileInfo.indexOf("{@render actionsSection()}", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = fileInfo.slice(start, end);

    expect(block).toContain("<audio");
    expect(block).toContain("controls");
    expect(block).toContain('preload="metadata"');
    expect(block).toContain("withTokenQuery(`/api/files/${encodeURIComponent(entry.path)");
    expect(block).not.toContain("autoplay");
  });

  test("keeps decode errors local to the inline player", () => {
    expect(fileInfo).toMatch(
      /import \{ AUDIO_UNSUPPORTED_MESSAGE \} from "\.\.\/state\/audioViewer";/,
    );
    expect(fileInfo).toMatch(/onerror=\{\(\) => \(audioError = true\)\}/);
    expect(fileInfo).toMatch(
      /\{#if audioError\}[\s\S]{1,120}role="status"[\s\S]{1,80}\{AUDIO_UNSUPPORTED_MESSAGE\}/,
    );
  });
});
