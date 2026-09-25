// @vitest-environment jsdom
//
// The Dashboard's Workspace slot configuration: the recent workspaces this
// machine opened, and nothing else to configure.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import WorkspaceSlotConfig from "./WorkspaceSlotConfig.svelte";

vi.mock("../../api/client", () => ({
  api: {
    config: vi.fn(async () => ({
      workspaces: [
        { path: "/home/me/dev/chan", last_seen_at: "2026-09-24T10:30:00Z" },
        { path: "/srv/notes/", last_seen_at: "2026-09-20T08:00:00Z" },
      ],
    })),
  },
}));

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(WorkspaceSlotConfig, { target, props: {} }));
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  return target;
}

describe("the Workspace slot configuration", () => {
  test("is one Workspaces section listing the recent workspaces", async () => {
    const target = await render();

    expect([...target.querySelectorAll("h3")].map((el) => el.textContent)).toEqual(["Workspaces"]);
    expect(target.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    const names = [...target.querySelectorAll(".recents-name")].map((el) => el.textContent);
    expect(names).toEqual(["chan", "notes"]);
    expect(target.querySelector(".recents-path")?.textContent).toBe("/home/me/dev/chan");
    expect(target.querySelector(".recents-time")?.textContent).toBe("2026-09-24 10:30 UTC");
  });
});
