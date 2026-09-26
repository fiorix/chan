// @vitest-environment jsdom
//
// A survey's `close_survey` and `open_survey` each go out once, so a window
// whose `/ws` socket is down when one is sent never gets it. Every socket that
// attaches is told instead which surveys are still open in its window
// (`survey_sync`), and the overlays converge on that list. These deliver,
// through the app's own watcher socket, the frames
// scripts/e2e/survey-reattach-ws.mjs recorded from a devserver, with only the
// window id rewritten to this window's.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

// The app's `/ws` watcher sockets, in dial order. They are the demo
// transport's own; the wrapper only keeps a hand on each, so a test can
// deliver a frame through its `onmessage` and drop it.
const watchers = vi.hoisted(() => [] as WebSocket[]);
vi.mock("./demo/socket", async (importOriginal) => {
  const demo = await importOriginal<typeof import("./demo/socket")>();
  return {
    ...demo,
    demoSocketFactory(url: string): WebSocket {
      const socket = demo.demoSocketFactory(url);
      if (new URL(url).pathname === "/ws") watchers.push(socket);
      return socket;
    },
  };
});

import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { resetLayout, terminalTab } from "./__tests__/tabs";
import { sessionWindowId } from "./api/client";
import { teardown } from "./state/store.svelte";
import { resetSurveysForTest, surveyFor } from "./state/survey.svelte";

stubAppEnvironment();

const RECORDED_WINDOW = "w-f1bd954baf3e50ea";

// What three sockets of one recorded survey-reattach-ws.mjs run received, in
// order, one entry per socket. The socket that attached after the deadline
// went on to receive the next phase's `open_survey`, which is left out: the
// test for that phase starts from a window that never saw it.
const RECORDED = {
  beforeTheDeadline: [
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
    { type: "window_command", window_id: "w-f1bd954baf3e50ea", command: "survey_sync", surveys: [] },
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
    { type: "window_command", window_id: "w-f1bd954baf3e50ea", command: "open_survey", survey: { surveyId: "survey-eenEMyzrrtScH657fz6EaRJSTCBEUUZp", title: null, bodyMarkdown: "expires while the window is away", options: ["ok"] }, tabName: "@@E2E" },
  ],
  afterTheDeadline: [
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
    { type: "window_command", window_id: "w-f1bd954baf3e50ea", command: "survey_sync", surveys: [] },
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
  ],
  whileOpen: [
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
    { type: "window_command", window_id: "w-f1bd954baf3e50ea", command: "survey_sync", surveys: [{ survey: { surveyId: "survey-vsWLMCT33cKSYSRvZGiV58eLQaDKamrt", title: null, bodyMarkdown: "still open when the window comes back", options: ["yes", "no"] }, tabName: "@@E2E" }] },
    { type: "session_roster", participants: [{ window_id: "w-f1bd954baf3e50ea", name: "pirukidaba", role: "leader", status: "live" }], leader: "w-f1bd954baf3e50ea" },
  ],
};

const TERMINAL = "term-e2e";

beforeEach(async () => {
  watchers.length = 0;
  await mountApp();
  resetLayout([terminalTab({ id: TERMINAL, title: "@@E2E" })]);
  await settle();
});

afterEach(async () => {
  resetSurveysForTest();
  // The watcher outlives an unmount; closing it here makes the next mount
  // dial its own, as a reloaded window does.
  teardown();
  await unmountApp();
});

function deliver(socket: WebSocket, frames: readonly object[]): void {
  for (const frame of frames) {
    const data = JSON.stringify(frame).replaceAll(RECORDED_WINDOW, sessionWindowId());
    socket.onmessage?.call(socket, new MessageEvent("message", { data }));
  }
}

function overlayBody(): string | null {
  return document.querySelector(".terminal-tab .survey-overlay .survey-body")?.textContent ?? null;
}

describe("the survey overlays converge on what the server still waits on", () => {
  test("an overlay whose survey expired while the socket was down is gone once it reattaches", async () => {
    expect(watchers).toHaveLength(1);
    deliver(watchers[0], RECORDED.beforeTheDeadline);
    await settle();
    expect(overlayBody()).toContain("expires while the window is away");

    watchers[0].close();
    await vi.waitFor(() => expect(watchers).toHaveLength(2), { timeout: 3_000 });
    deliver(watchers[1], RECORDED.afterTheDeadline);
    await settle();

    expect(surveyFor(TERMINAL)).toBeNull();
    expect(document.querySelector(".survey-overlay")).toBeNull();
  });

  test("a window that attaches while a survey is open raises it on its terminal", async () => {
    expect(watchers).toHaveLength(1);
    deliver(watchers[0], RECORDED.whileOpen);
    await settle();

    expect(surveyFor(TERMINAL)?.surveyId).toBe("survey-vsWLMCT33cKSYSRvZGiV58eLQaDKamrt");
    expect(overlayBody()).toContain("still open when the window comes back");
  });
});
