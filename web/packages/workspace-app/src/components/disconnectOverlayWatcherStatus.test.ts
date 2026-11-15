// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import { COVER_ROOT_ATTR, raisedCoverKeys, ui } from "../state/store.svelte";
import { linkHealth, resetLinkHealthForTests, setLinkWatchStatus, watchLinkProbe } from "../state/linkHealth.svelte";

// A watcher drop starts the cover grace. Opening a redial alone does not heal
// the outage; its first pong does.

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  resetLinkHealthForTests();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(DisconnectOverlay, { target }) as Record<string, unknown>);
  return target;
}

describe("DisconnectOverlay follows a watcher outage", () => {
  test("a force-close surfaces the cover and a redial pong clears it", async () => {
    vi.useFakeTimers();
    resetLinkHealthForTests();
    setLinkWatchStatus("open");
    ui.ws = "open"; // watcher healthy at least once this session
    const target = render();
    await tick();
    expect(target.querySelector(".overlay")).toBeNull(); // hidden while open

    watchLinkProbe.pingSent();
    watchLinkProbe.frameReceived();
    watchLinkProbe.pongReceived();
    watchLinkProbe.reset();
    setLinkWatchStatus("reconnecting", { reason: "closed", lastFrameAt: Date.now() });
    ui.ws = "reconnecting";
    await tick();
    vi.advanceTimersByTime(600);
    await tick();
    const overlay = target.querySelector(".overlay");
    expect(overlay).not.toBeNull();
    expect(target.querySelector(".title")?.textContent).toContain("reconnecting");
    // The cover registers the app-wide input block while it is up: the global
    // key handlers are document-level and would otherwise keep driving the app
    // behind it.
    expect(raisedCoverKeys()).toContain("reconnect");
    // Its root carries the cover's name, which the window key guard reads to
    // scope the one exception it makes for a cover's own text field.
    expect(overlay?.getAttribute(COVER_ROOT_ATTR)).toBe("reconnect");
    // Its delayed recovery buttons act on a click, so no key typed on this cover passes
    // the guard's exception for a cover's own text field.
    expect(overlay?.querySelectorAll("input, textarea, [contenteditable]").length).toBe(0);

    setLinkWatchStatus("open");
    ui.ws = "open";
    await tick();
    expect(linkHealth.state).toBe("down");
    expect(target.querySelector(".overlay")).not.toBeNull();
    watchLinkProbe.pingSent();
    watchLinkProbe.frameReceived();
    watchLinkProbe.pongReceived();
    await tick();
    expect(target.querySelector(".overlay")).toBeNull();
    expect(raisedCoverKeys()).not.toContain("reconnect");
  });
});
