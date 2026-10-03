// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import ExcalidrawCanvas, { canonicalJson, distinctIds, noteVersions, sceneDeltas } from "./ExcalidrawCanvas.svelte";
import { boardPropsFromRender } from "../__tests__/excalidrawLibrary";
// Build-time contract: the offscreen shell is display: none (WKWebView leaks the island through visibility: hidden), and the island imports Excalidraw's stylesheet so it rides the island's chunk; vitest drops CSS.
import canvasSrc from "./ExcalidrawCanvas.svelte?raw";
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
const { createRootMock, renderMock, unmountMock, modules, boardAppState } = vi.hoisted(() => {
  // The appState keys the library's serializer keeps, with the defaults a
  // board holds from its constructor and its restore gives a scene that
  // lacks them.
  const boardAppState: Record<string, unknown> = {
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: false,
    viewBackgroundColor: "#ffffff",
  };
  const renderMock = vi.fn();
  const unmountMock = vi.fn();
  const createRootMock = vi.fn(() => ({ render: renderMock, unmount: unmountMock }));
  const modules = {
    "react-dom/client": { createRoot: createRootMock },
    react: {
      Component: class {
        props: unknown;
        state: Record<string, unknown> = {};
        constructor(props: unknown) { this.props = props; }
      },
      createElement: (type: unknown, props: Record<string, unknown>, child?: unknown) =>
        ({ type, props: child === undefined ? props : { ...props, children: child } }),
    },
    "@excalidraw/excalidraw": {
      Excalidraw: () => null,
      // Mimics the real cleaner's shape: elements + the appState keys the
      // library exports, so the appState-baseline logic is testable.
      serializeAsJSON: (elements: unknown, appState: Record<string, unknown>) =>
        JSON.stringify({
          elements,
          appState: Object.fromEntries(
            Object.entries(appState).filter(([k]) => k in boardAppState),
          ),
          files: {},
        }),
      // Mimics the real restore's visible part: selection elements dropped, a
      // missing version made 1, and every appState key it knows answered, a
      // missing one at its default, the view keys the serializer drops among
      // them.
      restore: (
        data: {
          elements?: Record<string, unknown>[] | null;
          appState?: Record<string, unknown> | null;
          files?: Record<string, unknown> | null;
        } | null,
      ) => ({
        elements: (data?.elements ?? [])
          .filter((el) => el.type !== "selection")
          .map((el) => ({ ...el, version: el.version || 1 })),
        appState: Object.fromEntries(
          Object.entries({
            ...boardAppState,
            viewModeEnabled: false,
            zoom: { value: 1 },
            scrollX: 0,
            scrollY: 0,
            selectedElementIds: {},
            activeTool: { type: "selection" },
          }).map(([k, v]) => [k, data?.appState?.[k] ?? v]),
        ),
        files: data?.files ?? {},
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
    },
  };
  return { createRootMock, renderMock, unmountMock, modules, boardAppState };
});
vi.mock("react-dom/client", () => modules["react-dom/client"]);
vi.mock("react", () => modules.react);
vi.mock("@excalidraw/excalidraw", () => modules["@excalidraw/excalidraw"]);

const mounted: Array<Record<string, unknown>> = [];
const renderedBoard = () => boardPropsFromRender(renderMock.mock.calls.at(-1)![0]);

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
});

describe("the installed React error boundary", () => {
  test("unmounts the failing child before notifying the boundary once", async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    const ReactDOM = await vi.importActual<typeof import("react-dom/client")>("react-dom/client");
    const { act } = await vi.importActual<{ act: (run: () => void) => Promise<void> }>("react-dom/test-utils");
    const events: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    class Child extends React.Component<{ fail: boolean }> {
      componentWillUnmount(): void { events.push("unmount"); }
      render(): unknown {
        if (this.props.fail) throw new Error("render failed");
        return React.createElement("span", null, "drawing");
      }
    }
    class Boundary extends React.Component<{ children: unknown }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
      componentDidCatch(): void { events.push("catch"); }
      render(): unknown { return this.state.failed ? null : this.props.children; }
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    try {
      await act(() => { root.render(React.createElement(Boundary, null, React.createElement(Child, { fail: false }))); });
      expect(host.textContent).toBe("drawing");
      await act(() => { root.render(React.createElement(Boundary, null, React.createElement(Child, { fail: true }))); });
      expect(events).toEqual(["unmount", "catch"]);
      expect(host.textContent).toBe("");
    } finally {
      await act(() => { root.unmount(); });
      errors.mockRestore();
      host.remove();
    }
  });
});

describe("inactive canvas tab hides via display:none (WKWebView island leak)", () => {
  // A GPU-composited Excalidraw island (the zoom/undo footer) leaks through
  // an ancestor's visibility:hidden in WKWebView; hiding the shell with
  // display:none stops it.
  test("the offscreen shell is display: none, not merely invisible", () => {
    expect(canvasSrc).toMatch(/\.excalidraw-shell\.offscreen \{\s*display: none;\s*\}/);
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
    return renderedBoard() as unknown as Record<string, unknown>;
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
});

describe("excalidraw stays out of the eager bundle", () => {
  // FileEditorTab.test.ts covers the tab reaching this module only through a
  // dynamic import; this module in turn loads React and excalidraw on mount.
  test("importing the island loads no React or excalidraw; mounting it does", async () => {
    // A fresh module graph, with each runtime module counting its evaluations.
    vi.resetModules();
    const loaded: Record<string, number> = {};
    for (const [id, module] of Object.entries(modules)) {
      loaded[id] = 0;
      vi.doMock(id, () => {
        loaded[id]! += 1;
        return module;
      });
    }
    await import("./ExcalidrawCanvas.svelte");
    expect(loaded).toEqual({ "react-dom/client": 0, react: 0, "@excalidraw/excalidraw": 0 });

    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: { content: "", dark: false, onSceneChange: () => {} },
      }),
    );
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    expect(loaded).toEqual({ "react-dom/client": 1, react: 1, "@excalidraw/excalidraw": 1 });
  });

  test("the stylesheet is imported by the island, so it rides the island's chunk", () => {
    expect(canvasSrc).toMatch(/import "@excalidraw\/excalidraw\/index\.css"/);
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
  /// How long after an `updateScene` the library's render shows its appState;
  /// a timer due sooner runs first.
  renderAfter: number;
};

/// A board whose `updateScene` replaces the elements at once and shows the
/// appState it is handed only at a later task, as the library's render does
/// for an update from outside it, reporting the change through `report` then.
function fakeApi(initial: WireElement[] = [], report: () => void = () => {}): FakeApi {
  let elements: Record<string, unknown>[] = [...initial];
  let appState: Record<string, unknown> = { selectedElementIds: {}, ...boardAppState };
  let files: Record<string, unknown> = {};
  const updateScene = vi.fn((s: Record<string, unknown>) => {
    if (Array.isArray(s.elements)) elements = s.elements as Record<string, unknown>[];
    const next = s.appState && typeof s.appState === "object" ? (s.appState as Record<string, unknown>) : null;
    setTimeout(() => {
      if (next) appState = { ...appState, ...next };
      report();
    }, fake.renderAfter);
  });
  const fake: FakeApi = {
    renderAfter: 0,
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
  return fake;
}

type SessionStub = {
  bindCanvas: ReturnType<typeof vi.fn>;
  unbindCanvas: ReturnType<typeof vi.fn>;
  pushScene: ReturnType<typeof vi.fn>;
  sendCursor: ReturnType<typeof vi.fn>;
  bufferMirrored: ReturnType<typeof vi.fn>;
  peerCursorSnapshot: () => Map<number, { w: string; x: number; y: number }>;
};

/// Mount the island with a stubbed session over a buffer that holds
/// `initial`, hand it a fake imperative API whose board holds the same, and
/// wait for the bind effect to hand the binding back.
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
    bufferMirrored: vi.fn(),
    peerCursorSnapshot: () => new Map([[7, { w: "win-peer", x: 1.5, y: 2 }]]),
  };
  mounted.push(
    mount(ExcalidrawCanvas, {
      target,
      props: {
        content: JSON.stringify({ elements: initial }),
        dark: false,
        onSceneChange,
        session: session as unknown as SceneSession,
      },
    }),
  );
  await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
  const rendered = renderedBoard();
  const api = fakeApi(initial, () => rendered.onChange());
  rendered.excalidrawAPI(api);
  await vi.waitFor(() => expect(session.bindCanvas).toHaveBeenCalled());
  return { api, session, binding: bound! };
}

/// The appStates the canvas handed the session to push.
const pushedAppStates = (session: SessionStub) =>
  session.pushScene.mock.calls.map((call) => call[1]).filter((appState) => appState !== undefined);

/// The library reports a change, as it does after each render.
function libraryChange(): void {
  renderedBoard().onChange();
}

describe("a board that has not taken its first seed", () => {
  test("hands its session nothing", async () => {
    // The host gives a canvas a session only once its tab has loaded, so a
    // board mounted with a session and a load in flight is a pair of props
    // the host does not produce. It holds whatever the handover put there,
    // none of it the user's, and must not offer it.
    const target = document.createElement("div");
    document.body.append(target);
    const session: SessionStub = {
      bindCanvas: vi.fn(),
      unbindCanvas: vi.fn(),
      pushScene: vi.fn(() => true),
      sendCursor: vi.fn(),
      bufferMirrored: vi.fn(),
      peerCursorSnapshot: () => new Map(),
    };
    mounted.push(
      mount(ExcalidrawCanvas, {
        target,
        props: {
          content: JSON.stringify({ elements: [wireEl("handed-over", 1)] }),
          dark: false,
          onSceneChange: () => {},
          session: session as unknown as SceneSession,
          loaded: false,
        },
      }),
    );
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());
    const rendered = renderedBoard();
    rendered.excalidrawAPI(fakeApi([wireEl("handed-over", 1)], () => rendered.onChange()));
    vi.useFakeTimers();
    rendered.onChange();
    vi.advanceTimersByTime(300);
    vi.useRealTimers();

    expect({ bound: session.bindCanvas.mock.calls.length, pushed: session.pushScene.mock.calls.length }).toEqual({
      bound: 0,
      pushed: 0,
    });
  });
});

describe("scene session binding loop safety", () => {
  test("a restored version matches an untouched board and a later edit still pushes", async () => {
    const withoutVersion = { id: "x", type: "rectangle", versionNonce: 1, isDeleted: false } as WireElement;
    const { api, session, binding } = await mountBound([withoutVersion]);
    expect(api.getSceneElementsIncludingDeleted()[0]!.version).toBe(1);

    binding.applySnapshot([wireEl("x", 1)], undefined, {});
    expect(binding.hasPendingLocal()).toBe(false);
    binding.flushPendingLocal();
    expect(session.pushScene).not.toHaveBeenCalled();

    api.setElements([wireEl("x", 2)]);
    expect(binding.hasPendingLocal()).toBe(true);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "x", version: 2 })],
      undefined,
      undefined,
    );
  });

  test("a remote apply never enters undo and never re-pushes", async () => {
    const { api, session, binding } = await mountBound([]);
    binding.applyUpdate({ elements: [wireEl("x", 5)] });

    const call = api.updateScene.mock.calls.find((c) =>
      ((c[0] as { elements?: { id: string }[] }).elements ?? []).some((el) => el.id === "x"),
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
    const rendered = renderedBoard();

    // The authority fans an appState; adopting it must not echo back.
    binding.applyUpdate({ elements: [], appState: { ...boardAppState, gridSize: 5 } });
    rendered.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).not.toHaveBeenCalled();

    // A genuine local appState change pushes exactly once.
    api.setAppState({ gridSize: 9 });
    rendered.onChange();
    vi.advanceTimersByTime(300);
    expect(session.pushScene).toHaveBeenCalledTimes(1);
    rendered.onChange();
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

    binding.forgetBroadcast([wireEl("pasted", 2)], pasted);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledTimes(2);
    expect(session.pushScene.mock.calls[1]![2]).toEqual(pasted);
  });

  test("unmounting unbinds the session", async () => {
    const { session } = await mountBound([]);
    unmount(mounted.pop()!);
    expect(session.unbindCanvas).toHaveBeenCalledTimes(1);
  });

  test("a local delete pushes its tombstone", async () => {
    const { api, session, binding } = await mountBound([wireEl("a", 3)]);
    binding.flushPendingLocal();
    session.pushScene.mockClear();

    api.setElements([wireEl("a", 4, { isDeleted: true })]);
    binding.flushPendingLocal();
    expect(session.pushScene).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "a", version: 4, isDeleted: true })],
      undefined,
      undefined,
    );
  });

  test("a local delete beats a slower remote update of the same element", async () => {
    const { api, binding } = await mountBound([wireEl("x", 8, { isDeleted: true })]);
    binding.applyUpdate({ elements: [wireEl("x", 6)] });
    expect(api.getSceneElementsIncludingDeleted()).toEqual([
      expect.objectContaining({ id: "x", version: 8, isDeleted: true }),
    ]);
  });
});

describe("an untouched live board pushes no appState", () => {
  // The authority's frames carry an object's keys sorted, where the board
  // holds them in the library's order.
  const AUTHORITY_ORDER = { gridModeEnabled: false, gridSize: 20, gridStep: 5, viewBackgroundColor: "#ffffff" };


  test("a stored appState of {} is not pushed back as the library's defaults", async () => {
    vi.useFakeTimers();
    try {
      const { session, binding } = await mountBound([]);
      binding.applySnapshot([], {}, {});
      binding.flushPendingLocal();
      libraryChange();
      vi.advanceTimersByTime(300);

      expect(pushedAppStates(session)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a stored appState with keys the serializer drops is not pushed", async () => {
    vi.useFakeTimers();
    try {
      const { session, binding } = await mountBound([]);
      binding.applySnapshot([], { ...boardAppState, theme: "dark", zoom: { value: 2 } }, {});
      libraryChange();
      vi.advanceTimersByTime(300);

      expect(pushedAppStates(session)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the serializer's keys in the authority's order are not pushed back", async () => {
    vi.useFakeTimers();
    try {
      const { session, binding } = await mountBound([]);
      binding.applySnapshot([], AUTHORITY_ORDER, {});
      libraryChange();
      vi.advanceTimersByTime(300);

      expect(pushedAppStates(session)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an adopt hands the board only the appState keys the serializer keeps", async () => {
    const { api, binding } = await mountBound([]);
    api.updateScene.mockClear();
    binding.applySnapshot([], { ...boardAppState, theme: "dark", zoom: { value: 2 } }, {});

    const handed = api.updateScene.mock.calls
      .map((call) => (call[0] as { appState?: Record<string, unknown> }).appState)
      .filter((appState) => appState !== undefined);
    expect(handed.map((appState) => Object.keys(appState!).sort())).toEqual([Object.keys(boardAppState).sort()]);
  });

  test("a peer's change in the authority's order reaches the board and is not pushed back", async () => {
    vi.useFakeTimers();
    try {
      const { api, session, binding } = await mountBound([]);
      binding.applySnapshot([], { ...boardAppState }, {});
      libraryChange();
      vi.advanceTimersByTime(300);
      session.pushScene.mockClear();

      binding.applyUpdate({ elements: [], appState: { ...AUTHORITY_ORDER, viewBackgroundColor: "#000000" } });
      vi.advanceTimersByTime(300);

      expect({ shown: api.getAppState().viewBackgroundColor, pushed: pushedAppStates(session) }).toEqual({
        shown: "#000000",
        pushed: [],
      });
    } finally {
      vi.useRealTimers();
    }
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

describe("a push between an adopt and the library's render of it", () => {
  // A peer's background, which the board shows only at the library's render.
  const PEER = { ...boardAppState, viewBackgroundColor: "#000000" };

  /// A bound board that has adopted the authority's appState and flushed it.
  async function settledBoard(onSceneChange: (json: string) => void = () => {}) {
    const bound = await mountBound([], onSceneChange);
    bound.binding.applySnapshot([], { ...boardAppState }, {});
    libraryChange();
    vi.advanceTimersByTime(300);
    bound.session.pushScene.mockClear();
    return bound;
  }

  test("a flush that comes due before the render pushes nothing older", async () => {
    vi.useFakeTimers();
    try {
      const onSceneChange = vi.fn();
      const { api, session, binding } = await settledBoard(onSceneChange);
      // A cursor frame's render arms the flush, and the library renders the
      // adopt after that timer has run.
      libraryChange();
      vi.advanceTimersByTime(150);
      api.renderAfter = 100;
      binding.applyUpdate({ elements: [], appState: PEER });
      vi.advanceTimersByTime(60);

      expect({
        shown: api.getAppState().viewBackgroundColor,
        pushed: pushedAppStates(session),
        mirrored: String(onSceneChange.mock.calls.at(-1)?.[0] ?? ""),
      }).toEqual({ shown: "#ffffff", pushed: [], mirrored: expect.stringContaining("#000000") });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a close's flush before the render pushes nothing older", async () => {
    vi.useFakeTimers();
    try {
      const onSceneChange = vi.fn();
      const { api, session, binding } = await settledBoard(onSceneChange);
      libraryChange();
      binding.applyUpdate({ elements: [], appState: PEER });
      (mounted.at(-1) as unknown as { flushPendingEdits: () => void }).flushPendingEdits();

      expect({
        shown: api.getAppState().viewBackgroundColor,
        pushed: pushedAppStates(session),
        mirrored: String(onSceneChange.mock.calls.at(-1)?.[0] ?? ""),
      }).toEqual({ shown: "#ffffff", pushed: [], mirrored: expect.stringContaining("#000000") });
    } finally {
      vi.useRealTimers();
    }
  });

  // The session pushes at once after a snapshot, after the bind's replay and
  // after an update while a save waits, with no render in between.
  test.each([
    ["a snapshot", (binding: SceneCanvasBinding) => binding.applySnapshot([], PEER, {})],
    ["an update", (binding: SceneCanvasBinding) => binding.applyUpdate({ elements: [], appState: PEER })],
  ])("a push right after %s is adopted sends nothing older", async (_frame, adopt) => {
    vi.useFakeTimers();
    try {
      const { session, binding } = await settledBoard();
      adopt(binding);
      binding.flushPendingLocal();

      expect(pushedAppStates(session)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a live board's own appState change", () => {
  test.each([
    ["the grid", { gridModeEnabled: true }],
    ["the background", { viewBackgroundColor: "#123456" }],
  ])("a change of %s after an adopt pushes once", async (_what, change) => {
    vi.useFakeTimers();
    try {
      const { api, session, binding } = await mountBound([]);
      // The authority's frames sort an object's keys.
      binding.applySnapshot([], { gridModeEnabled: false, gridSize: 20, gridStep: 5, viewBackgroundColor: "#ffffff" }, {});
      libraryChange();
      vi.advanceTimersByTime(300);

      api.setAppState(change);
      libraryChange();
      vi.advanceTimersByTime(300);
      libraryChange();
      vi.advanceTimersByTime(300);

      expect(pushedAppStates(session)).toEqual([{ ...boardAppState, ...change }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the canvas's mirror and the session's saved mark", () => {
  test("an appState the session refuses is offered once, and its mirror is reported for the session to judge", async () => {
    vi.useFakeTimers();
    try {
      const onSceneChange = vi.fn();
      const { api, session, binding } = await mountBound([], onSceneChange);
      binding.applySnapshot([], { ...boardAppState }, {});
      libraryChange();
      vi.advanceTimersByTime(300);
      // The session drops the push: its socket is closing.
      session.pushScene.mockReturnValue(false);
      session.bufferMirrored.mockClear();

      session.pushScene.mockClear();

      api.setAppState({ gridModeEnabled: true });
      libraryChange();
      vi.advanceTimersByTime(300);
      // The session holds the refused appState as this window's claim, so a
      // later flush offers nothing of it.
      libraryChange();
      vi.advanceTimersByTime(300);
      binding.flushPendingLocal();

      expect({
        mirrored: String(onSceneChange.mock.calls.at(-1)?.[0] ?? ""),
        reported: session.bufferMirrored.mock.calls.length,
        offered: pushedAppStates(session),
      }).toEqual({
        mirrored: expect.stringContaining('"gridModeEnabled":true'),
        reported: 1,
        offered: [{ ...boardAppState, gridModeEnabled: true }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a mirror of a peer's element is reported", async () => {
    vi.useFakeTimers();
    try {
      const { session, binding } = await mountBound([]);
      binding.applySnapshot([], { ...boardAppState }, {});
      libraryChange();
      vi.advanceTimersByTime(300);
      session.bufferMirrored.mockClear();

      binding.applyUpdate({ elements: [wireEl("peer", 1)] });
      vi.advanceTimersByTime(300);

      expect(session.bufferMirrored).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("canonicalJson", () => {
  test("the same keys and values in another order give one text, nested too", () => {
    const board = { gridSize: 20, gridStep: 5, grid: { mode: true, step: 5 }, viewBackgroundColor: "#ffffff" };
    const authority = { grid: { step: 5, mode: true }, gridSize: 20, gridStep: 5, viewBackgroundColor: "#ffffff" };
    expect(canonicalJson(board)).toBe(canonicalJson(authority));
    expect(canonicalJson(board)).not.toBe(canonicalJson({ ...authority, gridSize: 10 }));
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
  test("flushes the last stroke before unmounting the React root", async () => {
    vi.useFakeTimers();
    try {
      const onSceneChange = vi.fn();
      const { api, session } = await mountBound([], onSceneChange);
      const rendered = renderedBoard();
      api.setElements([wireEl("last-stroke", 1)]);
      rendered.onChange();
      vi.advanceTimersByTime(50);
      expect(onSceneChange).not.toHaveBeenCalled();
      await unmount(mounted.pop()!);

      expect(onSceneChange).toHaveBeenCalledWith(expect.stringContaining("last-stroke"));
      expect(session.pushScene).toHaveBeenCalled();
      expect(onSceneChange.mock.invocationCallOrder[0]).toBeLessThan(unmountMock.mock.invocationCallOrder[0]!);
      vi.advanceTimersByTime(250);
      expect(onSceneChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Whether the element is lost turns on what reaches the server, and the
  // classic PUT writes `tab.content`. The serialize mirror runs whether or
  // not a session is bound and whether or not the push was taken, so the
  // element a dropped push never sent is still in the buffer.
  test("a dropped push still mirrors the element into the tab buffer", async () => {
    vi.useFakeTimers();
    const onSceneChange = vi.fn();
    const { api, session } = await mountBound([], onSceneChange);
    session.pushScene.mockReturnValue(false);
    const rendered = renderedBoard();

    api.setElements([wireEl("drawn-during-outage", 3)]);
    rendered.onChange();
    vi.advanceTimersByTime(300);

    expect(session.pushScene).toHaveBeenCalled();
    expect(onSceneChange).toHaveBeenCalled();
    expect(String(onSceneChange.mock.calls.at(-1)![0])).toContain(
      "drawn-during-outage",
    );
    vi.useRealTimers();
  });
});

describe("distinctIds", () => {
  const ids = (elements: readonly unknown[]) => distinctIds(elements).map((el) => (el as { id?: unknown } | null)?.id);

  test("each element after the first of a repeated id takes the id and its place among the repeats", () => {
    expect(distinctIds([{ id: "a", x: 0 }, { id: "b", x: 1 }, { id: "a", x: 2 }, { id: "a", x: 3 }])).toEqual([
      { id: "a", x: 0 },
      { id: "b", x: 1 },
      { id: "a-2", x: 2 },
      { id: "a-3", x: 3 },
    ]);
  });

  test("a derived id passes over every id the scene holds, before the repeat or after it", () => {
    expect(ids([{ id: "a-2" }, { id: "a" }, { id: "a" }, { id: "a" }, { id: "a-3" }])).toEqual([
      "a-2",
      "a",
      "a-4",
      "a-5",
      "a-3",
    ]);
  });

  test("an element whose id is not a string is left as it is and repeats nothing", () => {
    const scene = [{ id: 7 }, { id: 7 }, { x: 1 }, { x: 2 }, null, { id: "a" }, { id: "a" }];
    expect(distinctIds(scene)).toEqual([{ id: 7 }, { id: 7 }, { x: 1 }, { x: 2 }, null, { id: "a" }, { id: "a-2" }]);
  });
});
