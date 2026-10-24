// @vitest-environment jsdom

import { mount, tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("./__tests__/xterm")).webglAddonModule());

import App from "./App.svelte";
import { installDemoWorkspace } from "./demo/install";
import { teardownDemoApp } from "./demo/teardown";
import { trackTimers } from "./demo/timers";
import { filesContext } from "./state/fileContext.svelte";
import { pathPromptState, resolvePathPrompt } from "./state/store.svelte";
import { activePane, activeTabInPane } from "./state/tabs.svelte";
import { installEditorDom } from "./__tests__/wysiwyg";

installEditorDom();

let teardown: (() => Promise<void>) | null = null;

afterEach(async () => {
  resolvePathPrompt(null);
  await teardown?.();
  teardown = null;
  filesContext.current = null;
  document.body.innerHTML = "";
});

async function mountApp(): Promise<void> {
  const timers = trackTimers();
  const mounted: Array<Record<string, unknown>> = [];
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }));
  teardown = () => teardownDemoApp({ mounted, timers });
  for (let i = 0; i < 6; i += 1) await tick();
}

function newFile(): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.file.new" } }));
}

describe("the New file command", () => {
  test("proposes and creates under the standalone start directory", async () => {
    await mountApp();
    filesContext.current = { rootDisplay: "/", rootWire: "", homeWire: "home/u", identity: "files" };
    newFile();

    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    expect(pathPromptState.defaultValue).toBe("home/u/untitled.md");
    resolvePathPrompt(pathPromptState.defaultValue);
    await vi.waitFor(() => {
      const tab = activeTabInPane(activePane());
      expect(tab?.kind === "file" && tab.path).toBe("home/u/untitled.md");
    });
  });

  test("proposes a root file when no file context exists", async () => {
    await mountApp();
    newFile();

    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    expect(pathPromptState.defaultValue).toBe("untitled.md");
  });
});
