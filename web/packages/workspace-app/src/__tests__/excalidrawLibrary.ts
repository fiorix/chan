// A stand-in for the Excalidraw board, for tests that mount ExcalidrawCanvas
// with React and the drawing library mocked out. It keeps the library's order
// of events, which the canvas's seeding depends on, and the parts of its
// restore and its serializer that a test can see.
//
// The order is read from @excalidraw/excalidraw 0.18.1's source
// (dist/dev/index.js) and was not run in a browser:
//   1. <InitializeApp> awaits a locale import before it renders <App>, and then
//      renders the children of its latest render (:910-921). The wrapper
//      renders again on every call (:33038-33073), so App is built with the
//      props of the render in effect when the locale arrives.
//   2. App's constructor starts with `isLoading: true` and hands the imperative
//      API over (:29454), before componentDidMount.
//   3. initializeScene awaits the initial data of the props App was built with
//      (:25241-25245), restores it (:25262) and replaces every element with it
//      (:25130-25131), wiping any `updateScene` made since step 2, then clears
//      `isLoading` (:25272).
//   4. `onChange` fires after every update once `isLoading` is false
//      (:30536-30538): the first is the init's own, and none comes before it.
//   5. After the init, `updateScene` replaces the elements at once, but sets
//      its appState through `setState` (:25957-25961), which `getAppState()`
//      shows only at the render the update schedules (:29433); its `onChange`
//      follows that render.
//
// The restore and the serializer are read from dist/dev/chunk-4FTI6OG3.js.
//
// EXCALIDRAW_VERSION is the version all of this was read from. A test fails
// when the installed package is another, so an upgrade reads it all again.

export const EXCALIDRAW_VERSION = "0.18.1";

/// The appState keys the library's serializer keeps (chunk:583-585, :630),
/// with the defaults its restore gives a scene that lacks them (chunk:241-242,
/// :479-481, :518).
const SERIALIZED_APP_STATE: Record<string, unknown> = {
  gridSize: 20,
  gridStep: 5,
  gridModeEnabled: false,
  viewBackgroundColor: "#ffffff",
};

type Element = Record<string, unknown>;
type AppState = Record<string, unknown>;
type Files = Record<string, unknown>;
type Scene = { elements?: Element[] | null; appState?: AppState | null; files?: Files | null };

/// The library's `restore` (chunk:20669-20851), reduced to what a test can
/// see: it drops `selection` elements (:20674), gives an element without a
/// version the version 1 (:20454), and fills each appState key the scene lacks
/// with its default.
function restore(data: Scene | null): { elements: Element[]; appState: AppState; files: Files } {
  const supplied = data?.appState ?? {};
  const appState: AppState = {};
  for (const [key, fallback] of Object.entries(SERIALIZED_APP_STATE)) {
    appState[key] = supplied[key] !== undefined ? supplied[key] : fallback;
  }
  return {
    elements: (data?.elements ?? [])
      .filter((element) => element.type !== "selection")
      .map((element) => ({ ...element, version: element.version || 1 })),
    appState,
    files: data?.files ?? {},
  };
}

/// The library's `serializeAsJSON` for a "local" export (chunk:17928-17940):
/// the elements that are not deleted, the appState keys it exports in the
/// order the state holds them, and the files those elements reference.
function serializeAsJSON(elements: Element[], appState: AppState, files: Files): string {
  const kept = elements.filter((element) => !element.isDeleted);
  const exported: AppState = {};
  for (const key of Object.keys(appState)) {
    if (key in SERIALIZED_APP_STATE) exported[key] = appState[key];
  }
  const referenced = Object.fromEntries(
    Object.entries(files).filter(([id]) => kept.some((element) => element.fileId === id)),
  );
  return JSON.stringify({ elements: kept, appState: exported, files: referenced });
}

/// The module the canvas imports, for `vi.mock("@excalidraw/excalidraw")`.
export const excalidrawModule = {
  Excalidraw: () => null,
  restore,
  serializeAsJSON,
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", EVENTUALLY: "EVENTUALLY", NEVER: "NEVER" },
};

/// The props the canvas renders the board with, as the mocked createElement
/// hands them to the mocked root.
export type BoardProps = {
  initialData?: Scene | null;
  excalidrawAPI: (api: unknown) => void;
  onChange: () => void;
  viewModeEnabled?: boolean;
};

export type Board = {
  /// The elements on the board.
  readonly elements: unknown[];
  /// The appState keys the serializer keeps, as `getAppState()` shows them.
  readonly appState: AppState;
  /// The props of the render App was built with, from the handover on.
  readonly mountedWith: BoardProps | null;
  /// Steps 1 and 2: the locale import, then the API handover.
  handOver(): Promise<void>;
  /// Steps 3 and 4: the awaited initial data replaces every element, then the
  /// first `onChange`.
  init(): Promise<void>;
  /// Steps 1 to 4.
  start(): Promise<void>;
  /// A user's stroke: the library adds the element and reports the change.
  stroke(element: unknown): void;
};

/// A board whose App is built, at the handover, with the props of the render
/// `latest` returns then.
export function excalidrawBoard(latest: () => BoardProps): Board {
  let mountedWith: BoardProps | null = null;
  let elements: Element[] = [];
  let appState: AppState = { ...SERIALIZED_APP_STATE };
  let files: Files = {};
  let loading = true;
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({ ...appState, isLoading: loading }),
    getFiles: () => files,
    addFiles(list: { id: string }[]) {
      for (const file of list) if (!(file.id in files)) files = { ...files, [file.id]: file };
    },
    updateScene(scene: { elements?: Element[]; appState?: AppState }) {
      if (scene.elements) elements = scene.elements;
      const next = scene.appState;
      queueMicrotask(() => {
        if (next) appState = { ...appState, ...next };
        if (!loading) latest().onChange();
      });
    },
  };
  return {
    get elements() {
      return elements;
    },
    get appState() {
      return Object.fromEntries(Object.keys(SERIALIZED_APP_STATE).map((key) => [key, appState[key]]));
    },
    get mountedWith() {
      return mountedWith;
    },
    async handOver() {
      await Promise.resolve();
      mountedWith = latest();
      mountedWith.excalidrawAPI(api);
    },
    async init() {
      const scene = restore((await mountedWith!.initialData) ?? null);
      elements = scene.elements;
      appState = { ...appState, ...scene.appState };
      files = { ...scene.files };
      loading = false;
      latest().onChange();
    },
    async start() {
      await this.handOver();
      await this.init();
    },
    stroke(element) {
      elements = [...elements, element as Element];
      latest().onChange();
    },
  };
}
