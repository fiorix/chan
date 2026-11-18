// A connected devserver's connection face on the Computers deck: the face
// beside its name on every card, the detail under its address on the card
// in front, nothing on the local machine's card or a row with no reading,
// and both behind one reveal in privacy mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { setPrivacy } from "@chan/web-shared/privacy";
import Library from "./Library.svelte";
import { library } from "../state/library.svelte";
import { resetDeck, showCard } from "../state/deck.svelte";
import type { ConnectionHealth, DevserverEntry } from "../api/library";

vi.mock("../api/backend", async () => ({ backend: (await import("../api/mock")).mockApi }));

const NOW = 1_800_000_000_000;

function reading(over: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    face: "healthy",
    since: NOW - 60_000,
    rtt_ms: 24,
    wait_since: null,
    last_contact: NOW - 1_000,
    samples: [{ at: NOW - 4_000, rtt_ms: 20 }, { at: NOW - 1_000, rtt_ms: 24 }],
    ...over,
  };
}

function computer(id: string, label: string, connection_health: ConnectionHealth | null, status: DevserverEntry["status"] = "connected"): DevserverEntry {
  return {
    id, url: `http://${label}.example:8787`, host: `${label}.example`, port: 8787, label, script: "", has_token: false,
    library_id: null, status, pending_signin: false, auto_hide_control: false, os: "linux", pretty_name: null,
    gateway_id: null, gateway_url: "", shared: false, native_trust_required: false, connection_health,
  };
}

let app: ReturnType<typeof mount> | null = null;

function mountDeck(front: string): void {
  showCard("computers", front);
  app = mount(Library, { target: document.body });
  flushSync();
}

const slot = (key: string) => document.querySelector<HTMLElement>(`.slot[data-key="${key}"]`)!;
const face = (key: string) => slot(key).querySelector<HTMLElement>(".ds-name-row .connection-face");
const detail = (key: string) => slot(key).querySelector<HTMLElement>(".ds-health .connection-detail");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  resetDeck();
  library.workspaces = [];
  library.windows = [];
  library.gateways = [];
});

afterEach(async () => {
  if (app) await unmount(app);
  app = null;
  document.body.innerHTML = "";
  library.devservers = [];
  await setPrivacy({ enabled: false });
  vi.useRealTimers();
});

describe("the connection face on the Computers deck", () => {
  it("shows the face beside the name and the detail under the address on the card in front", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "slow", since: NOW - 27_000, rtt_ms: 1_300, samples: [{ at: NOW - 4_000, rtt_ms: 20 }, { at: NOW - 1_000, rtt_ms: 1_300 }] }))];
    mountDeck("ds-a");
    expect(slot("ds-a").classList.contains("active")).toBe(true);
    expect(face("ds-a")!.dataset.face).toBe("slow");
    expect(face("ds-a")!.textContent!.trim()).toBe("1.3 s");
    expect(face("ds-a")!.title).toBe("Connection slow, 1.3 s");
    const text = detail("ds-a")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Slow for 27 s");
    expect(text).toContain("Latest 1.3 s Median 660 ms Worst 1.3 s");
    expect(text).toContain("Last contact");
    const header = slot("ds-a").querySelector(".machine-header")!;
    expect(header.compareDocumentPosition(detail("ds-a")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a card not in front its face without the detail, and the local machine's card neither", () => {
    library.devservers = [computer("ds-a", "alpha", reading())];
    mountDeck("local");
    expect(face("ds-a")!.dataset.face).toBe("healthy");
    expect(detail("ds-a")).toBeNull();
    expect(slot("local").querySelector(".connection-face, .connection-detail")).toBeNull();
  });

  it("shows no face for an unconnected row or a row that carries no reading key", () => {
    const keyless = computer("ds-b", "bravo", null) as Partial<DevserverEntry>;
    delete keyless.connection_health;
    library.devservers = [computer("ds-a", "alpha", null, "disconnected"), keyless as DevserverEntry];
    mountDeck("ds-a");
    expect(document.querySelector(".connection-face, .connection-detail")).toBeNull();
    showCard("computers", "ds-b");
    flushSync();
    expect(document.querySelector(".connection-face, .connection-detail")).toBeNull();
  });

  it("counts a stalled wait against the clock", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "stalled", since: NOW - 1_000, wait_since: NOW - 5_000 }))];
    mountDeck("ds-a");
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 5 s");
    expect(detail("ds-a")!.textContent).toContain("No response for 5 s");
    vi.advanceTimersByTime(2_000);
    flushSync();
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 7 s");
    expect(detail("ds-a")!.textContent).toContain("No response for 7 s");
  });

  it("counts a fresh reading from the moment it arrives, not from the clock's last tick", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "slow", since: NOW - 3_000, rtt_ms: 30, wait_since: NOW - 3_000 }))];
    mountDeck("ds-a");
    expect(face("ds-a")!.textContent!.trim()).toBe("3.0 s");
    // 900 ms on, before the clock's next tick, the desktop reads the 4 s
    // stall and the row arrives.
    vi.setSystemTime(NOW + 900);
    library.devservers = [computer("ds-a", "alpha", reading({ face: "stalled", since: NOW + 900, wait_since: NOW + 900 - 4_000 }))];
    flushSync();
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 4 s");
    expect(detail("ds-a")!.textContent).toContain("No response for 4 s");
  });

  it("counts reconnecting from its start while a ping still waits", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "reconnecting", since: NOW - 12_000, wait_since: NOW - 40_000 }))];
    mountDeck("ds-a");
    expect(face("ds-a")!.textContent!.trim()).toBe("reconnecting");
    expect(face("ds-a")!.title).toBe("Connection lost, reconnecting");
    expect(detail("ds-a")!.textContent).toContain("Reconnecting for 12 s");
  });

  it("shows the mark alone before the first reply and while recovering", () => {
    library.devservers = [
      computer("ds-a", "alpha", reading({ face: "unknown", rtt_ms: null, last_contact: null, samples: [] })),
      computer("ds-b", "bravo", reading({ face: "slow", rtt_ms: 250 })),
    ];
    mountDeck("ds-a");
    expect(face("ds-a")!.textContent!.trim()).toBe("");
    expect(face("ds-a")!.title).toBe("Connection status unknown");
    const text = detail("ds-a")!.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("No reading yet");
    expect(text).toContain("Latest - Median - Worst - Last contact -");
    expect(face("ds-b")!.textContent!.trim()).toBe("");
    expect(face("ds-b")!.title).toBe("Connection recovering");
  });

  it("keeps the colour in privacy mode and puts the words and detail behind one reveal", async () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "slow", since: NOW - 27_000, rtt_ms: 1_300 }))];
    await setPrivacy({ enabled: true });
    mountDeck("ds-a");
    expect(face("ds-a")!.dataset.face).toBe("slow");
    expect(face("ds-a")!.title).toBe("Connection details");
    expect(slot("ds-a").textContent).not.toContain("1.3 s");
    expect(slot("ds-a").textContent).not.toContain("Slow for");
    const reveals = slot("ds-a").querySelectorAll<HTMLButtonElement>('[aria-label="Reveal connection details"]');
    expect(reveals).toHaveLength(1);
    reveals[0]!.click();
    flushSync();
    expect(face("ds-a")!.textContent).toContain("1.3 s");
    expect(detail("ds-a")!.textContent).toContain("Slow for 27 s");
  });

  it("keeps the privacy reveal out of the face's image, whose children a screen reader skips", async () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "slow", rtt_ms: 1_300 }))];
    await setPrivacy({ enabled: true });
    mountDeck("ds-a");
    const reveal = face("ds-a")!.querySelector<HTMLButtonElement>('[aria-label="Reveal connection details"]')!;
    expect(reveal.closest('[role="img"]'), "the reveal sits inside the image").toBeNull();
    const image = face("ds-a")!.querySelector<HTMLElement>('[role="img"]')!;
    expect(image.getAttribute("aria-label")).toBe("Connection details");
    expect(image.querySelector("button, a, input")).toBeNull();
  });
});

// The description a screen reader reads for `el`: each element its
// aria-describedby names, by its aria-label or else its text.
function description(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id))
    .map((ref) => ref?.getAttribute("aria-label") ?? ref?.textContent?.trim() ?? "")
    .join(" ");
}

describe("the connection face for a screen reader", () => {
  it("describes a configured devserver's edit button, whose label replaces its content, with the face's name", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "stalled", since: NOW - 1_000, wait_since: NOW - 5_000 }))];
    mountDeck("ds-a");
    const edit = slot("ds-a").querySelector<HTMLButtonElement>("button.ds-id.editable")!;
    expect(edit.getAttribute("aria-label")).toBe("Edit config for alpha");
    expect(description(edit)).toBe("Connection stalled");
    library.devservers = [computer("ds-a", "alpha", reading({ face: "slow", rtt_ms: 1_300 }))];
    flushSync();
    expect(description(edit)).toBe("Connection slow, 1.3 s");
  });

  it("gives the edit button no description while the row shows no face", () => {
    library.devservers = [computer("ds-a", "alpha", null)];
    mountDeck("ds-a");
    const edit = slot("ds-a").querySelector<HTMLButtonElement>("button.ds-id.editable")!;
    expect(edit.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("the face's clock", () => {
  let visibility: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => visibility.mockRestore());

  const show = (state: DocumentVisibilityState) => {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
    flushSync();
  };

  it("stops while the screen is hidden and reads the time again when it shows", () => {
    library.devservers = [computer("ds-a", "alpha", reading({ face: "stalled", since: NOW - 1_000, wait_since: NOW - 5_000 }))];
    mountDeck("ds-a");
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 5 s");
    show("hidden");
    vi.advanceTimersByTime(3_000);
    flushSync();
    expect(face("ds-a")!.textContent!.trim(), "the clock ticked while hidden").toBe("stalled 5 s");
    expect(vi.getTimerCount(), "a timer runs while hidden").toBe(0);
    show("visible");
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 8 s");
    vi.advanceTimersByTime(1_000);
    flushSync();
    expect(face("ds-a")!.textContent!.trim()).toBe("stalled 9 s");
  });
});
