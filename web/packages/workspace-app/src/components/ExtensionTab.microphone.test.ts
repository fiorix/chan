// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../api/client";
import type { ExtensionInfo } from "../api/types";
import { commandById } from "../state/commands";
import { EXTENSION_MICROPHONE_REQUEST } from "../state/extensionBridge";
import { extensionFor, refreshExtensions } from "../state/extensions.svelte";
import { resetLayout } from "../__tests__/tabs";
import { activePane, type ExtensionTab as ExtensionTabState } from "../state/tabs.svelte";
import ExtensionTab from "./ExtensionTab.svelte";

const ENTRY: ExtensionInfo = {
  id: "echo",
  name: "Echo",
  entry_path: `/_chan/extensions/echo/${"a".repeat(64)}/`,
  singleton: true,
  running: true,
  capabilities: ["microphone"],
};

let view: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

async function show(capabilities: ExtensionInfo["capabilities"]): Promise<HTMLIFrameElement> {
  resetLayout([]);
  vi.spyOn(api, "extensions").mockResolvedValue([{ ...ENTRY, capabilities }]);
  await refreshExtensions();
  commandById("extension.echo")!.run();
  const opened = activePane().tabs[0];
  if (opened?.kind !== "extension") throw new Error("expected an extension tab");
  target = document.createElement("div");
  document.body.append(target);
  view = mount(ExtensionTab, {
    target,
    props: { tab: opened as ExtensionTabState, paneId: activePane().id },
  });
  flushSync();
  await tick();
  const frame = target.querySelector("iframe");
  if (!frame) throw new Error("expected an extension iframe");
  return frame;
}

function requestStart(frame: HTMLIFrameElement): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        type: EXTENSION_MICROPHONE_REQUEST,
        request_id: "request-1",
        action: "start",
      },
    }),
  );
}

afterEach(async () => {
  if (view) await unmount(view);
  view = null;
  target?.remove();
  target = null;
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("extension microphone capability", () => {
  test("a frame without the grant cannot reach the microphone", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const frame = await show([]);
    requestStart(frame);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  test("a granted frame starts parent-owned capture without relaxing its sandbox", async () => {
    const getUserMedia = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("MediaRecorder", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const frame = await show(["microphone"]);
    expect(extensionFor("echo")?.capabilities).toEqual(["microphone"]);
    expect(frame.contentWindow).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-forms allow-scripts");
    expect(frame.hasAttribute("allow")).toBe(false);
    requestStart(frame);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  });
});
