// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import ExcalidrawCanvas, { noteVersions, sceneDeltas } from "./ExcalidrawCanvas.svelte";
import canvasSrc from "./ExcalidrawCanvas.svelte?raw";
import fileEditorSrc from "../components/FileEditorTab.svelte?raw";
import type {
  SceneCanvasBinding,
  SceneSession,
  WireElement,
} from "../state/sceneSync.svelte";

// Excalidraw + React are heavy; mock the three runtime modules the wrapper
// dynamic-imports so mounting the island in jsdom never pulls the real
// React runtime (mirrors diagram.test.ts). vi.mock is hoisted and
// intercepts dynamic imports too; the spies go through vi.hoisted so the
// hoisted mock factory can reference them without a TDZ error.
const { createRootMock, renderMock, unmountMock } = vi.hoisted(() => {
  const renderMock = vi.fn();
  const unmountMock = vi.fn();
  const createRootMock = vi.fn(() => ({ render: renderMock, unmount: unmountMock }));
  return { createRootMock, renderMock, unmountMock };
});
vi.mock("react-dom/client", () => ({ createRoot: createRootMock }));
vi.mock("react", () => ({
  createElement: (type: unknown, props: unknown) => ({ type, props }),
}));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  // Mimics the real cleaner's shape: elements + a cleaned appState
  // (selection dropped) so the appState-baseline logic is testable.
  serializeAsJSON: (elements: unknown, appState: Record<string, unknown>) =>
    JSON.stringify({
      elements,
      appState: Object.fromEntries(
        Object.entries(appState).filter(([k]) => k !== "selectedElementIds"),
      ),
      files: {},
    }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", EVENTUALLY: "EVENTUALLY", NEVER: "NEVER" },
  // Test double of the vendored LWW reconcile, id-keyed with the
  // version core of the real rule (the exact rule is pinned by the
  // server port and its tests); enough to observe which side survives.
  reconcileElements: (
    local: readonly Record<string, unknown>[],
    remote: readonly Record<string, unknown>[],
  ) => {
    const out = new Map<string, Record<string, unknown>>();
    for (const el of local) out.set(el.id as string, el);
    for (const el of remote) {
      const mine = out.get(el.id as string);
      if (!mine || (mine.version as number) <= (el.version as number)) {
        out.set(el.id as string, el);
      }
    }
    return [...out.values()];
  },
}));

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  createRootMock.mockClear();
  renderMock.mockClear();
  unmountMock.mockClear();
});

describe("ExcalidrawCanvas island", () => {
  test("creates exactly one React root and renders the board", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, onSceneChange: () => {} },
      }),
    );
    // onMount awaits the dynamic imports before it renders.
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".excalidraw-host")).not.toBeNull();
  });

  test("unmounting tears the React root down", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const comp = mount(ExcalidrawCanvas, {
      target,
      props: { content: "", dark: false, onSceneChange: () => {} },
    });
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    unmount(comp);
    expect(unmountMock).toHaveBeenCalledTimes(1);
  });

  test("the board host follows the shared page-width cap", () => {
    expect(canvasSrc).toContain("width: min(100%, var(--chan-page-max-width, 100%))");
    expect(canvasSrc).toContain(".excalidraw-shell");
    expect(canvasSrc).toContain("var(--page-shade)");
  });
});

describe("inactive canvas tab hides via display:none (WKWebView island leak)", () => {
  // A GPU-composited Excalidraw island (the zoom/undo footer) leaks through
  // an ancestor's visibility:hidden in WKWebView; hiding the shell with
  // display:none stops it.
  test("the shell gains an offscreen hook toggled off the active prop", () => {
    expect(canvasSrc).toContain("class:offscreen={!active}");
    expect(canvasSrc).toMatch(/\.excalidraw-shell\.offscreen \{\s*display: none;\s*\}/);
  });

  test("FileEditorTab passes active into the canvas island", () => {
    expect(fileEditorSrc).toMatch(/<ExcalidrawCanvas[\s\S]*?\{active\}/);
  });

  test("mounting with active:false applies the offscreen class", () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, active: false, onSceneChange: () => {} },
      }),
    );
    const shell = target.querySelector(".excalidraw-shell");
    expect(shell).not.toBeNull();
    expect(shell?.classList.contains("offscreen")).toBe(true);
  });

  test("the active prop defaults true so a plain mount is not hidden", () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, onSceneChange: () => {} },
      }),
    );
    const shell = target.querySelector(".excalidraw-shell");
    expect(shell?.classList.contains("offscreen")).toBe(false);
  });
});

describe("a read-only canvas tab", () => {
  // The board is the one editor surface that ignored the tab's read-only
  // state, so read mode and a file with no user-write bit both left it
  // editable. Every change it produced was refused by the live session and
  // could never be confirmed, which is what leaves a save waiting for a
  // quiescence that cannot arrive.
  function renderProps(): Record<string, unknown> {
    const rendered = renderMock.mock.calls.at(-1)![0] as {
      props: Record<string, unknown>;
    };
    return rendered.props;
  }

  test("renders the board in view mode", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, readonly: true, onSceneChange: () => {} },
      }),
    );
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(renderProps().viewModeEnabled).toBe(true);
  });

  test("a writable tab keeps its board editable", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, onSceneChange: () => {} },
      }),
    );
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(renderProps().viewModeEnabled).toBe(false);
  });

  test("FileEditorTab passes its read-only state into the canvas island", () => {
    // Bounded to the element: an unbounded `[\s\S]*?` reaches the `readonly`
    // on the source editor further down and passes either way.
    const island = fileEditorSrc.match(/<ExcalidrawCanvas[\s\S]*?\/>/)?.[0] ?? "";
    expect(island, "the canvas island is mounted here").toContain("ExcalidrawCanvas");
    expect(island).toContain("readonly={readOnly}");
  });
});

describe("excalidraw stays out of the eager bundle", () => {
  test("the wrapper dynamic-imports react-dom, react, and excalidraw", () => {
    expect(canvasSrc).toMatch(/import\("react-dom\/client"\)/);
    expect(canvasSrc).toMatch(/import\("react"\)/);
    expect(canvasSrc).toMatch(/import\("@excalidraw\/excalidraw"\)/);
    // A static runtime import would drag React into the eager editor bundle.
    expect(canvasSrc).not.toMatch(/from "react"/);
    expect(canvasSrc).not.toMatch(/from "react-dom\/client"/);
    expect(canvasSrc).not.toMatch(/from "@excalidraw\/excalidraw"/);
  });

  test("index.css is a side-effect import so it rides the async chunk", () => {
    expect(canvasSrc).toMatch(/import "@excalidraw\/excalidraw\/index\.css"/);
  });

  test("FileEditorTab reaches the wrapper only via dynamic import", () => {
    expect(fileEditorSrc).toMatch(/import\("\.\.\/editor\/ExcalidrawCanvas\.svelte"\)/);
    expect(fileEditorSrc).not.toMatch(/from "\.\.\/editor\/ExcalidrawCanvas\.svelte"/);
  });
});

// ---- live scene session binding ---------------------------------------------

function wireEl(id: string, version: number, extra: Record<string, unknown> = {}): WireElement {
  return { id, type: "rectangle", version, versionNonce: 1, isDeleted: false, ...extra };
}

type FakeApi = {
  getSceneElementsIncludingDeleted: () => Record<string, unknown>[];
  getSceneElements: () => Record<string, unknown>[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
  addFiles: ReturnType<typeof vi.fn>;
  updateScene: ReturnType<typeof vi.fn>;
  setElements: (next: Record<string, unknown>[]) => void;
  setAppState: (patch: Record<string, unknown>) => void;
  setFiles: (next: Record<string, unknown>) => void;
};

function fakeApi(initial: WireElement[] = []): FakeApi {
  let elements: Record<string, unknown>[] = [...initial];
  let appState: Record<string, unknown> = { selectedElementIds: {} };
  let files: Record<string, unknown> = {};
  const updateScene = vi.fn((s: Record<string, unknown>) => {
    if (Array.isArray(s.elements)) elements = s.elements as Record<string, unknown>[];
    if (s.appState && typeof s.appState === "object") {
      appState = { ...appState, ...(s.appState as Record<string, unknown>) };
    }
  });
  return {
    getSceneElementsIncludingDeleted: () => elements,
    getSceneElements: () => elements.filter((e) => e.isDeleted !== true),
    getAppState: () => appState,
    getFiles: () => files,
    addFiles: vi.fn(),
    updateScene,
    setElements(next) {
      elements = next;
    },
    setAppState(patch) {
      appState = { ...appState, ...patch };
    },
    setFiles(next) {
      files = next;
    },
  };
}

type SessionStub = {
  bindCanvas: ReturnType<typeof vi.fn>;
  unbindCanvas: ReturnType<typeof vi.fn>;
  pushScene: ReturnType<typeof vi.fn>;
  sendCursor: ReturnType<typeof vi.fn>;
  peerCursorSnapshot: () => Map<number, { w: string; x: number; y: number }>;
};

/// Mount the island with a stubbed session, hand it a fake imperative
/// API, and wait for the bind effect to hand the binding back.
async function mountBound(
  initial: WireElement[] = [],
  onSceneChange: (json: string) => void = () => {},
): Promise<{ api: FakeApi; session: SessionStub; binding: SceneCanvasBinding }> {
  const target = document.createElement("div");
  document.body.append(target);
  let bound: SceneCanvasBinding | null = null;
  const session: SessionStub = {
    bindCanvas: vi.fn((b: SceneCanvasBinding) => {
      bound = b;
    }),
    unbindCanvas: vi.fn(),
    pushScene: vi.fn(() => true),
    sendCursor: vi.fn(),
    peerCursorSnapshot: () => new Map([[7, { w: "win-peer", x: 1.5, y: 2 }]]),
  };
  mounted.push(
    mount(ExcalidrawCanvas, {
      target,
      props: {
        content: "",
        dark: false,
        onSceneChange,
        session: session as unknown as SceneSession,
      },
    }),
  );
  await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
  const rendered = renderMock.mock.calls.at(-1)![0] as {
    props: { excalidrawAPI: (a: unknown) => void };
  };
  const api = fakeApi(initial);
  rendered.props.excalidrawAPI(api);
  await vi.waitFor(() => expect(session.bindCanvas).toHaveBeenCalled());
  return { api, session, binding: bound! };
}

describe("scene session binding loop safety", () => {
  test("a remote apply never enters undo and never re-pushes", async () => {
    const { api, session, binding } = await mountBound([]);
    binding.applyUpdate({ elements: [wireEl("x", 5)] });

    const call = api.updateScene.mock.calls.find((c) =>
      Array.isArray((c[0] as Record<string, unknown>).elements),
    );
    expect(call).toBeDefined();
    expect((call![0] as Record<string, unknown>).captureUpdate).toBe("NEVER");

    expect(binding.hasPendingLocal()).toBe(false);
    binding.flushPendingLocal();
    expect(session.pushScene).not.toHaveBeenCalled();
  });

  test("a local change pushes once and the noted version never repeats", async () => {
    const { api, session, binding } = await mountBound([]);
    api.setElements([wireEl("a", 3)]);
    expect(binding.hasPendingLocal()).toBe(true);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    expect(binding.hasPendingLocal()).toBe(false);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(1);
  });

  test("a newer local element survives the reconcile and still pushes", async () => {
    const { api, session, binding } = await mountBound([wireEl("x", 7)]);
    binding.applyUpdate({ elements: [wireEl("x", 5)] });
    expect(api.getSceneElementsIncludingDeleted()[0]!.version).toBe(7);
    expect(binding.hasPendingLocal()).toBe(true);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "x", version: 7 })],
      undefined,
      undefined,
    );
  });

  test("collaborators repaint from the peer cursor snapshot", async () => {
    const { api, binding } = await mountBound([]);
    binding.collaboratorsChanged();
    const call = api.updateScene.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).collaborators !== undefined,
    );
    expect(call).toBeDefined();
    const collabs = (call![0] as { collaborators: Map<string, Record<string, unknown>> })
      .collaborators;
    const peer = collabs.get("7")!;
    // No roster row in this fixture: the window-id prefix identifies.
    expect(peer.username).toBe("win-peer");
    expect(peer.pointer).toEqual({ x: 1.5, y: 2, tool: "pointer" });
    expect((peer.color as { background: string }).background).toMatch(/^#/);
  });

  test("an adopted appState moves the baseline and never re-pushes", async () => {
    vi.useFakeTimers();
    const { api, session, binding } = await mountBound([]);
    const rendered = renderMock.mock.calls.at(-1)![0] as {
      props: { onChange: () => void };
    };

    // The authority fans an appState; adopting it must not echo back.
    binding.applyUpdate({ elements: [], appState: { gridSize: 5 } });
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).not.toHaveBeenCalled();

    // A genuine local appState change pushes exactly once.
    api.setAppState({ gridSize: 9 });
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("forgetting a push offers its files again", async () => {
    // `knownFiles` is the mark that keeps a file out of every later push,
    // so a push the authority never accepted has to drop it or the element
    // arrives referencing bytes nobody else has.
    const { api, session, binding } = await mountBound([]);
    const pasted = { "file-a": { dataURL: "data:image/png;base64,AAA" } };
    api.setFiles(pasted);
    api.setElements([wireEl("pasted", 2)]);

    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    expect(session.pushScene.mock.calls[0]![2]).toEqual(pasted);
    // Marked: nothing is offered a second time.
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(1);

    binding.forgetBroadcast([wireEl("pasted", 2)], undefined, pasted);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(2);
    expect(session.pushScene.mock.calls[1]![2]).toEqual(pasted);
  });

  test("forgetting a push offers its appState again", async () => {
    // `lastAuthorityAppStateJson` is the same kind of mark for the appState,
    // and the canvas sets it from the value it pushed rather than from one
    // the authority sent back.
    vi.useFakeTimers();
    const { api, session, binding } = await mountBound([]);
    const rendered = renderMock.mock.calls.at(-1)![0] as {
      props: { onChange: () => void };
    };

    api.setAppState({ gridSize: 9 });
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    const claimed = session.pushScene.mock.calls[0]![1] as Record<string, unknown>;
    expect(claimed).toBeDefined();
    // Marked: an unchanged appState is not offered again.
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(1);

    binding.forgetBroadcast([], claimed, undefined);
    rendered.props.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(2);
    expect(session.pushScene.mock.calls[1]![1]).toEqual(claimed);
    vi.useRealTimers();
  });

  test("unmounting unbinds the session", async () => {
    const { session } = await mountBound([]);
    unmount(mounted.pop()!);
    expect(session.unbindCanvas).toHaveBeenCalledTimes(1);
  });

  test("the collab path pins its load-bearing calls in source", () => {
    expect(canvasSrc).toContain("getSceneElementsIncludingDeleted");
    expect(canvasSrc).toContain("CaptureUpdateAction.NEVER");
    expect(canvasSrc).toMatch(/reconcileElements\(/);
    expect(fileEditorSrc).toMatch(/<ExcalidrawCanvas[\s\S]*?session=\{sceneSession\}/);
  });
});

describe("sceneDeltas bookkeeping", () => {
  test("delta detection keys on the recorded version", () => {
    const map = new Map<string, number>();
    const els = [wireEl("a", 1), wireEl("b", 2)];
    expect(sceneDeltas(els, map)).toHaveLength(2);
    noteVersions(map, els);
    expect(sceneDeltas(els, map)).toHaveLength(0);
    const bumped = [wireEl("a", 2), wireEl("b", 2)];
    expect(sceneDeltas(bumped, map).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("a dropped push is not recorded as sent", () => {
  test("an element drawn while the channel is down survives to the reconnect", async () => {
    const { api, session, binding } = await mountBound([]);
    // The session drops the push: a closed socket, a missing snapshot, or a
    // read-only attach. Nothing reached the authority.
    session.pushScene.mockReturnValue(false);

    api.setElements([wireEl("a", 3)]);
    expect(binding.hasPendingLocal()).toBe(true);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(1);

    // The element is still only local, so the reconnect flush must re-send it.
    expect(binding.hasPendingLocal()).toBe(true);
    session.pushScene.mockReturnValue(true);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(2);
    expect(binding.hasPendingLocal()).toBe(false);
  });
});

describe("the buffer the classic PUT would carry", () => {
  // Whether the element is lost turns on what reaches the server, and the
  // classic PUT writes `tab.content`. The serialize mirror runs whether or
  // not a session is bound and whether or not the push was taken, so the
  // element a dropped push never sent is still in the buffer.
  test("a dropped push still mirrors the element into the tab buffer", async () => {
    vi.useFakeTimers();
    const onSceneChange = vi.fn();
    const { api, session } = await mountBound([], onSceneChange);
    session.pushScene.mockReturnValue(false);
    const rendered = renderMock.mock.calls.at(-1)![0] as {
      props: { onChange: () => void };
    };

    api.setElements([wireEl("drawn-during-outage", 3)]);
    rendered.props.onChange();
    vi.advanceTimersByTime(300);

    expect(session.pushScene).toHaveBeenCalled();
    expect(onSceneChange).toHaveBeenCalled();
    expect(String(onSceneChange.mock.calls.at(-1)![0])).toContain(
      "drawn-during-outage",
    );
    vi.useRealTimers();
  });
});

