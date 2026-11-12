// @vitest-environment jsdom
//
// A settings index entry whose write raises a question, run from the command
// launcher over the real deck: Semantic search in a workspace whose embedding
// model is not on disk. The row asks on the deck's card before anything is
// sent, naming the model. The download runs on that answer alone, the card
// gives way to the list, and the row reads `downloading` and takes no press
// until the download ends. The deck stays open throughout. A refusal's Retry
// asks too, once the window has learned the model is not on disk.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => ({ library_id: "lib", windows: [], workspaces: [] })),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: vi.fn(),
}));

import CommandLauncher from "../CommandLauncher.svelte";
import { api } from "../../api/client";
import type { SemanticModelRegistry, SemanticState } from "../../api/types";
import { recordRequests, stopRecordingRequests } from "../../__tests__/fetch";
import { settingsPreferences } from "../../__tests__/settings";
import { resetLayout } from "../../__tests__/tabs";
import { demoWorkspaceInfo } from "../../demo/data";
import { clearRecentCommands } from "../../state/commands/recent.svelte";
import * as statusBus from "../../state/notify.svelte";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
  workspace,
} from "../../state/store.svelte";
import { resetShownPreferencesForTests } from "./preferenceState.svelte";
import { settingEntry } from "./settingsIndex";
import {
  WORKSPACE_STATE_MAX_AGE_MS,
  resetWorkspaceStateForTests,
} from "./workspace/workspaceState.svelte";

const SEMANTIC = settingEntry("workspace.semantic").label;

let semanticState: SemanticState;
let models: SemanticModelRegistry;
/// Ends the download the server is holding.
let finishDownload: () => void;
let component: Record<string, unknown> | null = null;
let target: HTMLElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function row(title: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
    (candidate) => candidate.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!found) throw new Error(`missing row ${title}`);
  return found;
}

function valueOf(title: string): string {
  return row(title).querySelector(".deck-result-value")?.textContent ?? "";
}

/// What the deck's card says, empty while the list shows.
function card(): string {
  return target.querySelector(".deck-operation")?.textContent ?? "";
}

function decision(label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`missing decision ${label}; card: ${card()}`);
  return found;
}

/// Press and release a key on the deck.
async function key(value: string): Promise<void> {
  const dialog = target.querySelector('[role="dialog"]') as HTMLElement;
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  dialog.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
  await flush();
}

/// Open the launcher on the typed results for the setting, whose row leads.
async function findSemanticSearch(): Promise<void> {
  openCommandLauncher();
  await flush();
  const field = target.querySelector(".deck-input") as HTMLInputElement;
  field.value = "semantic search";
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("off"));
  expect(
    target.querySelector('[role="option"][aria-selected="true"] .deck-result-title')?.textContent,
  ).toBe(SEMANTIC);
}

beforeEach(() => {
  sessionStorage.clear();
  clearRecentCommands();
  closeCommandLauncher();
  clearLauncherDraft();
  resetLayout();
  semanticState = {
    mode: "bm25",
    model_present: false,
    model_name: "bge-small",
    model_path: "/models/bge-small",
    model_size_bytes: 1,
    semantic_enabled: false,
  };
  models = {
    current_model: "bge-small",
    models: [
      {
        id: "bge-small",
        label: "BGE small",
        dim: 384,
        size_label: "130 MB",
        note: "",
        default: true,
        downloaded: false,
        current: true,
      },
    ],
  };
  finishDownload = () => {};
  vi.spyOn(api, "reportsState").mockResolvedValue({ enabled: false });
  vi.spyOn(api, "buildInfo").mockResolvedValue({
    version: "0",
    build: "test",
    features: { embeddings: true },
  });
  vi.spyOn(api, "semanticState").mockImplementation(async () => ({ ...semanticState }));
  vi.spyOn(api, "semanticModels").mockImplementation(
    async () => JSON.parse(JSON.stringify(models)) as SemanticModelRegistry,
  );
  vi.spyOn(api, "semanticDownload").mockImplementation(async () => {
    await new Promise<void>((resolve) => (finishDownload = resolve));
    semanticState = { ...semanticState, model_present: true };
    models.models[0]!.downloaded = true;
    return { ...semanticState };
  });
  vi.spyOn(api, "semanticEnable").mockImplementation(async () => {
    semanticState = { ...semanticState, semantic_enabled: true, mode: "hybrid" };
    return { ...semanticState };
  });
  vi.spyOn(api, "semanticDisable").mockImplementation(async () => {
    semanticState = { ...semanticState, semantic_enabled: false, mode: "bm25" };
    return { ...semanticState };
  });
  // Nothing else this window asks for is served.
  recordRequests(() => new Response(null, { status: 404 }));
  workspace.info = demoWorkspaceInfo(
    {
      metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    },
    settingsPreferences(),
  );
  target = document.createElement("div");
  document.body.append(target);
  component = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  closeCommandLauncher();
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = "";
  stopRecordingRequests();
  workspace.info = null;
  resetShownPreferencesForTests();
  resetWorkspaceStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a press asks on the card, naming the model, and only its answer downloads", async () => {
  const notified = vi.spyOn(statusBus, "notify");
  await findSemanticSearch();

  // One press sends nothing. It asks.
  row(SEMANTIC).click();
  await flush();
  expect(api.semanticDownload).not.toHaveBeenCalled();
  expect(api.semanticEnable).not.toHaveBeenCalled();
  expect(card()).toContain("Download BGE small?");
  expect(card()).toContain("130 MB");

  // Cancel is the list again, with the setting as it was.
  decision("Cancel").click();
  await flush();
  expect(card()).toBe("");
  expect(valueOf(SEMANTIC)).toBe("off");
  expect(api.semanticDownload).not.toHaveBeenCalled();

  // The answer starts the download. The card gives way to the list, where
  // the row says what is under way.
  row(SEMANTIC).click();
  await flush();
  decision("Download").click();
  await vi.waitFor(() => expect(api.semanticDownload).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(card()).toBe(""));
  expect(valueOf(SEMANTIC)).toBe("downloading");
  expect(row(SEMANTIC).getAttribute("aria-disabled")).toBe("true");
  expect(launcherPanel.open).toBe(true);

  // Enter on the row meanwhile does nothing: no card, no second write, no
  // refusal on the status line.
  await key("Enter");
  expect(card()).toBe("");
  expect(api.semanticDownload).toHaveBeenCalledTimes(1);
  expect(notified).not.toHaveBeenCalled();

  finishDownload();
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("on"));
  expect(api.semanticEnable).toHaveBeenCalledTimes(1);
  expect(row(SEMANTIC).getAttribute("aria-disabled")).toBe("false");
  expect(launcherPanel.open).toBe(true);

  // With the model on disk the row flips in place and asks nothing.
  row(SEMANTIC).click();
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("off"));
  row(SEMANTIC).click();
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("on"));
  expect(card()).toBe("");
  expect(api.semanticDownload).toHaveBeenCalledTimes(1);
  expect(notified).not.toHaveBeenCalled();
});

test("Enter twice downloads nothing: the card's first choice is Cancel", async () => {
  await findSemanticSearch();

  await key("Enter");
  expect(api.semanticDownload).not.toHaveBeenCalled();
  expect(card()).toContain("Download BGE small?");
  await key("Enter");
  expect(card()).toBe("");
  expect(valueOf(SEMANTIC)).toBe("off");
  expect(api.semanticDownload).not.toHaveBeenCalled();
  expect(api.semanticEnable).not.toHaveBeenCalled();

  // Choosing the action on the card is the answer that downloads.
  await key("Enter");
  await key("ArrowRight");
  await key("Enter");
  await vi.waitFor(() => expect(api.semanticDownload).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("downloading"));
  expect(launcherPanel.open).toBe(true);

  finishDownload();
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("on"));
});

test("Retry on a refusal asks first, once the window has learned the model is not on disk", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // The window reads the model as on disk.
  semanticState = { ...semanticState, model_present: true };
  models.models[0]!.downloaded = true;
  await findSemanticSearch();

  // The server has lost the model since, and the window's copy has aged out.
  semanticState = { ...semanticState, model_present: false };
  models.models[0]!.downloaded = false;
  vi.mocked(api.semanticEnable).mockRejectedValue(new Error("embedding model is not downloaded"));
  vi.setSystemTime(Date.now() + WORKSPACE_STATE_MAX_AGE_MS + 1);

  // The row asks nothing, by what the window knows, and the server refuses.
  row(SEMANTIC).click();
  await vi.waitFor(() => expect(card()).toContain("embedding model is not downloaded"));
  expect(api.semanticEnable).toHaveBeenCalledTimes(1);
  // The read behind the refusal brings the model's state.
  await vi.waitFor(() => expect(api.semanticModels).toHaveBeenCalledTimes(2));
  await flush();

  decision("Retry").click();
  await flush();
  expect(api.semanticDownload).not.toHaveBeenCalled();
  expect(card()).toContain("Download BGE small?");

  decision("Download").click();
  await vi.waitFor(() => expect(api.semanticDownload).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(valueOf(SEMANTIC)).toBe("downloading"));
});
