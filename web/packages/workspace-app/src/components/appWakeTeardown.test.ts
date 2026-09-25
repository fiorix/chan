// @vitest-environment jsdom
//
// The app's wake path belongs to the mounted app. After a wake (the tab shown
// again, or a wall-clock gap from a machine sleep) it runs one debounced
// resume: reconnect the watcher, refresh the tree and the workspace. Unmounting
// the app releases all of it: the wake-gap detector, the visibility listener
// and a resume still waiting on its debounce. And a resume whose refresh fails
// logs the failure; it never leaves a promise rejecting with no handler.
//
// The app is mounted for real over the demo backend because the wake block is
// the tail of App's own mount, after the bootstrap, and nothing smaller runs
// it. The wake-gap detector is wrapped so the test can tell App's install,
// whose callback is `scheduleResume`, from the watcher's and a terminal's.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

type DetectorInstall = { onWake: () => void; disposed: boolean };
const detectors = vi.hoisted(() => [] as DetectorInstall[]);

vi.mock("../wakeGap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wakeGap")>();
  return {
    ...actual,
    installWakeGapDetector: (onWake: () => void, options?: Parameters<typeof actual.installWakeGapDetector>[1]) => {
      const dispose = actual.installWakeGapDetector(onWake, options);
      const install: DetectorInstall = { onWake, disposed: false };
      detectors.push(install);
      return () => {
        install.disposed = true;
        dispose();
      };
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    write() {}
    writeln() {}
    resize() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

import App from "../App.svelte";
import { setFetchImpl } from "../api/transport";
import type { MockWorkspaceData } from "../demo/data";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import "../state/commands/install";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof requestAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});
// The resume runs only for a document that is visible.
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

/// The runner's own process, typed here rather than package-wide: an
/// unhandled rejection in a jsdom test is Node's, not the window's.
const runner = globalThis as unknown as {
  process: {
    on: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
    off: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
  };
};

/// App's resume debounce, which the tests wait out and look for by delay.
const RESUME_DEBOUNCE_MS = 300;

const mounted: Array<Record<string, unknown>> = [];

function demoData(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 1,
      textCount: 1,
    },
    files: [{ path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" }],
  };
}

/// App's own detector installs: the one whose wake callback is its resume.
function appDetectors(): DetectorInstall[] {
  return detectors.filter((d) => d.onWake.name === "scheduleResume");
}

/// Mount the app and wait until its mount has reached the wake block, which
/// runs after the bootstrap.
async function mountApp(): Promise<Record<string, unknown>> {
  installDemoWorkspace(demoData());
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(App, { target }) as Record<string, unknown>;
  mounted.push(app);
  await vi.waitFor(() => expect(appDetectors(), "App installed its wake path").toHaveLength(1));
  return app;
}

/// The ids of the resume debounce timers armed while `run` runs.
function resumeTimersArmedBy(run: () => void): unknown[] {
  const spy = vi.spyOn(globalThis, "setTimeout");
  try {
    run();
    return spy.mock.calls
      .map((call, i) => [call[1], spy.mock.results[i]?.value] as const)
      .filter(([delay]) => delay === RESUME_DEBOUNCE_MS)
      .map(([, id]) => id);
  } finally {
    spy.mockRestore();
  }
}

function wake(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(async () => {
  for (const app of mounted.splice(0)) unmount(app);
  // Let a resume that outlived its app fire here rather than in the next test.
  await new Promise((r) => setTimeout(r, RESUME_DEBOUNCE_MS + 50));
  detectors.splice(0);
  uninstallDemoWorkspace();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the app's wake path", () => {
  test("is released when the app unmounts", async () => {
    const app = await mountApp();
    // A wake just before the unmount leaves a resume waiting on its debounce.
    const pending = resumeTimersArmedBy(wake);
    expect(pending, "the wake armed one resume").toHaveLength(1);

    const cleared = vi.spyOn(globalThis, "clearTimeout");
    mounted.splice(mounted.indexOf(app), 1);
    unmount(app);
    const pendingCleared = cleared.mock.calls.some(([id]) => id === pending[0]);
    cleared.mockRestore();

    // A wake after the unmount has no app to resume.
    const armedAfter = resumeTimersArmedBy(wake);

    expect({
      detectorDisposed: appDetectors().every((d) => d.disposed),
      pendingResumeCleared: pendingCleared,
      resumesArmedAfterUnmount: armedAfter.length,
    }).toEqual({
      detectorDisposed: true,
      pendingResumeCleared: true,
      resumesArmedAfterUnmount: 0,
    });
  });

  test("logs a resume refresh that fails instead of leaving it unhandled", async () => {
    await mountApp();
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(String(reason));
    runner.process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The transport is down when the resume refreshes.
      setFetchImpl(async (input) => {
        throw new Error(`transport down: ${input}`);
      });
      wake();
      await new Promise((r) => setTimeout(r, RESUME_DEBOUNCE_MS + 50));
      // One more turn for a rejection nobody handled to be reported.
      await new Promise((r) => setTimeout(r, 20));
      await tick();
    } finally {
      runner.process.off("unhandledRejection", onUnhandled);
    }

    const resumeWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.startsWith("[chan] resume"));
    expect({ unhandled, resumeWarnings }).toEqual({
      unhandled: [],
      resumeWarnings: [
        "[chan] resume tree refresh failed",
        "[chan] resume workspace refresh failed",
      ],
    });
  });
});
