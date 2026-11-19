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

test("Settings says why the default stands in for a model the workspace named that chan dropped", async () => {
  const note =
    "BAAI/bge-m3 is no longer offered: its Hub repository publishes no model.safetensors. "
    + "This workspace uses BAAI/bge-small-en-v1.5 until a model is chosen.";
  const model = {
    id: "BAAI/bge-small-en-v1.5", label: "BGE Small EN v1.5", dim: 384, size_label: "~130 MB",
    note: "", default: true, downloaded: true, current: true,
  };
  const state = {
    mode: "bm25", model_present: true, model_name: model.id, model_note: note,
    model_path: "/models/bge-small", model_size_bytes: 1, semantic_enabled: false,
  };
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  recordRequests((request) => {
    if (request.path === "/api/build-info") return json({ version: "0", build: "test", features: { embeddings: true } });
    if (request.path === "/api/index/semantic/state") return json(state);
    if (request.path === "/api/index/semantic/models") return json({ current_model: model.id, models: [model] });
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  });
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(SemanticControl, { target }));
  await vi.waitFor(() => expect(target.querySelector("[role=note]")?.textContent).toBe(note));
});

test("Settings keeps the default that stands in for a dropped model and ends the note", async () => {
  const note =
    "BAAI/bge-m3 is no longer offered: its Hub repository publishes no model.safetensors. "
    + "This workspace uses BAAI/bge-small-en-v1.5 until a model is chosen.";
  const model = {
    id: "BAAI/bge-small-en-v1.5", label: "BGE Small EN v1.5", dim: 384, size_label: "~130 MB",
    note: "", default: true, downloaded: true, current: true,
  };
  let noted = true;
  const state = () => ({
    mode: "hybrid", model_present: true, model_name: model.id, model_note: noted ? note : null,
    model_path: "/models/bge-small", model_size_bytes: 1, semantic_enabled: true,
  });
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  const requests = recordRequests((request) => {
    if (request.path === "/api/build-info") return json({ version: "0", build: "test", features: { embeddings: true } });
    if (request.path === "/api/index/semantic/state") return json(state());
    if (request.path === "/api/index/semantic/models") return json({ current_model: model.id, models: [model] });
    if (request.path === "/api/index/semantic/model" && request.method === "PATCH") {
      noted = false;
      return json(state());
    }
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  });
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(SemanticControl, { target }));
  await vi.waitFor(() => expect(target.querySelector("[role=note]")?.textContent).toBe(note));
  const keep = [...target.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === `Keep ${model.id}`,
  );
  expect(keep, "a Keep action under the note").toBeDefined();
  keep!.click();
  await vi.waitFor(() => expect(target.querySelector("[role=note]")).toBeNull());
  expect(
    requests.filter((request) => request.method === "PATCH").map((request) => [request.path, request.body]),
  ).toEqual([["/api/index/semantic/model", { model: model.id }]]);
});
