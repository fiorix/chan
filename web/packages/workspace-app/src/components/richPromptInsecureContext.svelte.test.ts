// @vitest-environment jsdom
// Real RichPrompt mount + real strip clicks, covering the id the composer
// mints for each message it sends.
//
// `crypto.randomUUID` exists only in a secure context, and a devserver reached
// over plain http at a LAN address is not one, which is a supported way to run
// chan. So the id has to survive a global `crypto` that offers
// `getRandomValues` and nothing else, and it has to be the SAME id on the
// frame and on the pending card, minted fresh per message.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";

const readMock = vi.fn(async (_p: string) => ({ content: "" }) as unknown);
const writeSpy = vi.fn(async (_p: string, _c: string) => ({}) as unknown);
const promptSink = vi.fn((..._a: unknown[]) => true);

vi.mock("../api/client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      read: (p: string) => readMock(p),
      write: (p: string, c: string) => writeSpy(p, c),
    },
  };
});
vi.mock("../state/tabs.svelte", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sendPromptToTerminal: (...a: unknown[]) => promptSink(...a),
  };
});

import RichPrompt from "./RichPrompt.svelte";
import { showRichPromptForTab, richPrompt } from "../state/richPrompt.svelte";
import type { TerminalTab } from "../state/tabs.svelte";

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  readMock.mockResolvedValue({ content: "hello agent" } as unknown);
  writeSpy.mockClear();
  promptSink.mockClear();
  promptSink.mockReturnValue(true);
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  richPrompt.byTab = {};
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// A `$state` proxy, not a plain object: the component reads `tab.pendingPrompt`
// through a derived, and a plain object's mutations are invisible to it, so the
// strip's label would never follow a submit.
function makeTab(id: string): TerminalTab {
  const tab = $state({
    kind: "terminal",
    id,
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    richPromptDraftPath: `.Drafts/${id}/draft.md`,
  });
  return tab as TerminalTab;
}

/// What a page served over plain http actually gets: `getRandomValues` in any
/// context, `randomUUID` and `subtle` only in a secure one.
function insecureContextCrypto(): Crypto {
  const real = globalThis.crypto;
  return {
    getRandomValues: (array: ArrayBufferView) =>
      real.getRandomValues(array as never),
  } as unknown as Crypto;
}

async function mountComposer(tab: TerminalTab): Promise<HTMLElement> {
  showRichPromptForTab(tab.id);
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(
    mount(RichPrompt, { target, props: { tab } }) as Record<string, unknown>,
  );
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("composer did not mount");
  const view = EditorView.findFromDOM(content)!;
  for (let i = 0; i < 20 && view.state.doc.toString() !== "hello agent"; i++) {
    await tick();
    await Promise.resolve();
  }
  if (view.state.doc.toString() !== "hello agent") {
    throw new Error("composer did not load its draft");
  }
  await tick();
  return target;
}

function primaryOf(target: HTMLElement): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>(".rp-primary")!;
}

function sentId(): unknown {
  return promptSink.mock.calls[0]?.[3];
}

describe("the composer's message id", () => {
  test("submits on a server that is not a secure context", async () => {
    vi.stubGlobal("crypto", insecureContextCrypto());
    const tab = makeTab("term-1");
    const target = await mountComposer(tab);
    expect(primaryOf(target).disabled).toBe(false);

    primaryOf(target).click();
    await tick();

    // The message goes out and the card comes up. A bare `crypto.randomUUID()`
    // throws here instead, inside the click handler: nothing is sent, no card
    // appears, and the user is told nothing.
    expect(promptSink).toHaveBeenCalledTimes(1);
    expect(typeof sentId()).toBe("string");
    expect(sentId()).not.toBe("");
    expect(primaryOf(target).textContent?.trim()).toBe("esc cancel");
  });

  test("tags the frame and the pending card with one id", async () => {
    const tab = makeTab("term-1");
    const target = await mountComposer(tab);

    primaryOf(target).click();
    await tick();

    expect(promptSink).toHaveBeenCalledTimes(1);
    expect(tab.pendingPrompt).toEqual({ id: sentId(), phase: "sent" });
  });

  test("begins no pending card when the frame did not go out", async () => {
    // The data-loss guard: a refused send must leave the composer editable and
    // the text in it, not a greyed card for a message nobody received.
    promptSink.mockReturnValue(false);
    const tab = makeTab("term-1");
    const target = await mountComposer(tab);

    primaryOf(target).click();
    await tick();

    expect(tab.pendingPrompt).toBeUndefined();
    expect(primaryOf(target).textContent?.trim()).not.toBe("esc cancel");
  });

  test("mints a fresh id per message, in an insecure context too", async () => {
    vi.stubGlobal("crypto", insecureContextCrypto());
    const first = makeTab("term-1");
    primaryOf(await mountComposer(first)).click();
    await tick();
    const second = makeTab("term-2");
    primaryOf(await mountComposer(second)).click();
    await tick();

    expect(promptSink).toHaveBeenCalledTimes(2);
    const ids = promptSink.mock.calls.map((c) => c[3]);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});
