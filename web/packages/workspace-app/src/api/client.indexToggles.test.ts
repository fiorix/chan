// @vitest-environment jsdom
//
// The per-workspace index toggles. chan-reports and semantic search share one
// shape: a GET of the state, and a POST each to enable and disable, every one
// answering with the resulting state.

import { afterEach, describe, expect, test } from "vitest";
import { api } from "./client";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";

afterEach(stopRecordingRequests);

describe.each([
  {
    toggle: "reports",
    state: () => api.reportsState(),
    enable: () => api.reportsEnable(),
    disable: () => api.reportsDisable(),
  },
  {
    toggle: "semantic",
    state: () => api.semanticState(),
    enable: () => api.semanticEnable(),
    disable: () => api.semanticDisable(),
  },
])("the $toggle toggle", ({ toggle, state, enable, disable }) => {
  test("reads its state with a GET", async () => {
    const requests = recordRequests(() => json({ enabled: true }));

    await expect(state()).resolves.toMatchObject({ enabled: true });
    expect(requests).toMatchObject([{ method: "GET", path: `/api/index/${toggle}/state` }]);
  });

  test("turns on and off with a POST each, answering with the new state", async () => {
    let enabled = false;
    const requests = recordRequests((request) => {
      enabled = request.path.endsWith("/enable");
      return json({ enabled });
    });

    await expect(enable()).resolves.toMatchObject({ enabled: true });
    await expect(disable()).resolves.toMatchObject({ enabled: false });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", `/api/index/${toggle}/enable`],
      ["POST", `/api/index/${toggle}/disable`],
    ]);
  });
});
