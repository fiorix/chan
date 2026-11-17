// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { json, recordRequests, stopRecordingRequests } from "../../../__tests__/fetch";
import { demoWorkspaceInfo } from "../../../demo/data";
import { workspace } from "../../../state/store.svelte";
import SemanticControl from "./SemanticControl.svelte";
import { resetWorkspaceStateForTests } from "./workspaceState.svelte";

const mounted: Array<Record<string, unknown>> = [];

afterEach(async () => {
  for (const view of mounted.splice(0)) await unmount(view);
  resetWorkspaceStateForTests();
  workspace.info = null;
  stopRecordingRequests();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

test("Settings shows the model download refusal without losing the server's detail", async () => {
  const refusal = "The model server refused its certificate: opaque refusal detail";
  const model = {
    id: "bge-small", label: "BGE small", dim: 384, size_label: "130 MB",
    note: "", default: true, downloaded: false, current: true,
  };
  const state = {
    mode: "bm25", model_present: false, model_name: "bge-small",
    model_path: "/models/bge-small", model_size_bytes: 0, semantic_enabled: false,
  };
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  const requests = recordRequests((request) => {
    if (request.path === "/api/build-info") return json({ version: "0", build: "test", features: { embeddings: true } });
    if (request.path === "/api/index/semantic/state") return json(state);
    if (request.path === "/api/index/semantic/models") return json({ current_model: model.id, models: [model] });
    if (request.path === "/api/index/semantic/download") return json({ error: refusal }, { status: 500 });
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  });
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(SemanticControl, { target }));
  await vi.waitFor(() => expect(target.querySelector("input[type=checkbox]")).not.toBeNull());
  const toggle = target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  toggle.click();
  await vi.waitFor(() => expect(target.querySelector("[role=alert]")?.textContent).toBe(refusal));
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  expect(requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
    "/api/index/semantic/download",
  ]);
});
