// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import { raisedCoverKeys, ui } from "../state/store.svelte";

// The watcher transport now force-closes a zombie /ws -- when the read-deadline
// expires with no inbound frame, or when the wall-clock wake detector fires --
// and lets the existing reconnect loop redial. This overlay needs NO change to
// surface that: it is driven purely by the watcher status `ui.ws`, so a
// force-close that flips `ui.ws` off "open" reads exactly like a network drop.
// Proven by driving `ui.ws` against the UNMODIFIED overlay.

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(DisconnectOverlay, { target }) as Record<string, unknown>);
  return target;
}

describe("DisconnectOverlay follows the watcher status (no change needed)", () => {
  test("a force-close that flips ui.ws off 'open' surfaces then clears the overlay", async () => {
    vi.useFakeTimers();
    ui.ws = "open"; // watcher healthy at least once this session
    const target = render();
    await tick();
    expect(target.querySelector(".overlay")).toBeNull(); // hidden while open

    // The read-deadline / wake-gap force-close reconnects, flipping the watcher
    // status. Past the 600ms startup grace, the overlay must appear -- driven by
    // ui.ws alone, with no knowledge of the heartbeat that triggered the close.
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

    // The redial's fresh socket re-opens -> ui.ws "open" -> the overlay heals on
    // its own, no manual dismissal.
    ui.ws = "open";
    await tick();
    expect(target.querySelector(".overlay")).toBeNull();
    expect(raisedCoverKeys()).not.toContain("reconnect");
  });
});
