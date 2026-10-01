// The Enable semantic search command's status line: it advises downloading
// the embedding model when the server reports the model missing, and for any
// other refused enable it says why the enable failed.

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { allCommands } from "../commands";
import { ui } from "../store.svelte";
import "./search";

const MODEL_MISSING =
  "embedding model 'BAAI/bge-small-en-v1.5' not downloaded; expected at \"/tmp/model-cache/bge-small\". " +
  "Run `chan workspace index download-model` or rebuild with `--features embed-model`.";
const BUSY = "workspace busy: workspace state is temporarily unavailable; retry in a moment";

afterEach(() => {
  vi.restoreAllMocks();
  ui.status = null;
});

async function statusAfterRefusedEnable(error: Error): Promise<string | null> {
  vi.spyOn(api, "semanticEnable").mockRejectedValue(error);
  ui.status = null;
  allCommands()
    .find((command) => command.id === "app.semantic.enable")!
    .run();
  await vi.waitFor(() => expect(ui.status).not.toBeNull());
  return ui.status;
}

test.each([
  ["the workspace is busy", new ApiError(503, BUSY, { error: BUSY })],
  ["the 409 carries no code", new ApiError(409, "model_not_downloaded", { error: "model_not_downloaded" })],
  [
    "the 409 carries another code",
    new ApiError(409, "semantic search is unavailable", { error: "semantic search is unavailable", code: "other" }),
  ],
  [
    "the code comes with another status",
    new ApiError(500, MODEL_MISSING, { error: MODEL_MISSING, code: "model_not_downloaded" }),
  ],
])("an enable refused because %s says why it failed", async (_reason, error) => {
  expect(await statusAfterRefusedEnable(error)).toBe(`Enable failed: ${error.message}`);
});

test("an enable refused for a missing model advises downloading it", async () => {
  const error = new ApiError(409, MODEL_MISSING, {
    error: MODEL_MISSING,
    code: "model_not_downloaded",
    model_id: "BAAI/bge-small-en-v1.5",
    expected_dir: "/tmp/model-cache/bge-small",
    download_endpoint: "/api/index/semantic/download",
  });

  expect(await statusAfterRefusedEnable(error)).toBe(
    "Enable failed; download the embedding model in Search settings",
  );
});
