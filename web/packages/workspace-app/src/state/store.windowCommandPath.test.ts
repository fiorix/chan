// A window command carries a path from outside the page (`cs open`). It is a
// workspace path; a string that holds a draft's mark is refused, so a draft's
// client path enters the page from the identity module alone.

import { afterEach, expect, test, vi } from "vitest";

import { api, sessionWindowId } from "../api/client";
import { draftClientPath } from "../api/fileIdentity";
import { resetLayout } from "../__tests__/tabs";
import { onWatchEvent } from "./store.svelte";
import { activePane } from "./tabs.svelte";

const DRAFT = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });

function command(fields: Record<string, unknown>): void {
  onWatchEvent({ type: "window_command", window_id: sessionWindowId(), ...fields });
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function noServer(): void {
  vi.spyOn(api, "read").mockRejectedValue(new Error("no server in this test"));
  vi.spyOn(api, "readStream").mockRejectedValue(new Error("no server in this test"));
  vi.spyOn(api, "list").mockResolvedValue([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayout();
});

test("open_file opens a workspace path", async () => {
  noServer();
  resetLayout();

  command({ command: "open_file", path: "notes/a.md" });
  await settled();

  expect(
    activePane().tabs.map((t) => (t.kind === "file" ? t.path : t.kind)),
    "tabs opened",
  ).toEqual(["notes/a.md"]);
});

test("open_file refuses a marked path", async () => {
  noServer();
  resetLayout();

  command({ command: "open_file", path: DRAFT });
  await settled();

  expect(activePane().tabs, "tabs opened").toHaveLength(0);
});

test("open_browser refuses a marked path and a marked selection", async () => {
  noServer();
  resetLayout();

  command({ command: "open_browser", path: DRAFT });
  command({ command: "open_browser", path: "notes", select: DRAFT });
  await settled();

  expect(activePane().tabs, "tabs opened").toHaveLength(0);
});
