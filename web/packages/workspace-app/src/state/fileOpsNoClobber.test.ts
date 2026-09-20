import { describe, expect, test } from "vitest";
import promptModal from "../components/PathPromptModal.svelte?raw";
import store from "./store.svelte.ts?raw";

describe("File Browser no-clobber move policy", () => {
  test("performMove rejects Drafts sources and targets before api.move", () => {
    expect(store).toMatch(
      /const draftsReason =[\s\S]{1,200}fileBrowserDraftsPathReason\(path\) \?\? fileBrowserDraftsPathReason\(target\);[\s\S]{1,200}ui\.status = `move failed: \$\{draftsReason\}`;[\s\S]{1,80}return;/,
    );
  });
});

describe("File Browser Drafts create guard", () => {
  test("create prompts reject Drafts paths in their validators", () => {
    expect(store).toMatch(/function fileBrowserDraftsPathReason\(path: string\): string \| null/);
    expect(store).toMatch(
      /async createFile\(parentPath: string\): Promise<void> \{[\s\S]{1,1600}fileBrowserDraftsPathReason\(path\) \?\?/,
    );
    expect(store).toMatch(
      /async createDir\(parentPath: string\): Promise<void> \{[\s\S]{1,600}validate: fileBrowserDraftsPathReason,/,
    );
    expect(store).toMatch(
      /async createFileOrDir\(parentPath: string\): Promise<void> \{[\s\S]{1,600}fileBrowserDraftsPathReason\(path\) \?\?/,
    );
  });
});

describe("PathPrompt move collision copy", () => {
  test("existing directory targets are invalid for move", () => {
    expect(promptModal).toMatch(
      /if \(pathPromptState\.mode === "move"\) \{[\s\S]{1,240}if \(targetEntry\.is_dir\) \{[\s\S]{1,240}existing directory; choose a new path/,
    );
  });
});
