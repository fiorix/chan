// A stand-in for the Excalidraw board, for tests that mount ExcalidrawCanvas
// with React and the drawing library mocked out. It keeps the library's order
// of events, which the canvas's seeding depends on, and the parts of its
// restore, its serializer and its reconcile that a test can see.
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
//      follows that render. An update from outside an event takes React's
//      default priority (react-dom:10992-10999), which React renders in a
//      later task, so a timer can run first; `holdRenders` keeps that render
//      until the test runs it.
//   6. The init applies the restored appState through `syncActionResult`,
//      which keeps the `viewModeEnabled` prop over the restored value
//      (:25139-25146); `updateScene` applies whatever it is handed.
//   7. App's unmount destroys its scene and clears its files (:30285-30294);
//      its API getters read those fields at call time (:29427-29434).
//      React 18.3.1 renders null at a root with no boundary
//      (react-dom.development.js:18724-18741), or calls a class boundary's
//      componentDidCatch (:18746-18786). Deletions run in the mutation phase
//      before that callback's layout phase (:22891, :26849-26862).
//   8. After a scene gains image elements, the library decodes their files,
//      and for a file that fails it replaces every element, giving each
//      image of that file `status: "error"` (:28641-28666) in a copy whose
//      version, nonce and timestamp move; an image already marked is left
//      as it is (chunk:22848-22870). The replace is a scene update, so a
//      change is reported after it.
//
// The restore and the serializer are read from dist/dev/chunk-4FTI6OG3.js,
// the reconcile from dist/dev/index.js.
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

/// Keys of the board's appState the serializer drops, with the defaults the
/// library's restore gives them (chunk:465, :499-501, :520): view mode, zoom,
/// scroll, selection and the active tool.
const VIEW_APP_STATE: Record<string, unknown> = {
  viewModeEnabled: false,
  zoom: { value: 1 },
  scrollX: 0,
  scrollY: 0,
  selectedElementIds: {},
  activeTool: { type: "selection" },
};

/// The library's `restore` (chunk:20669-20851), reduced to what a test can
/// see: it drops `selection` elements (:20674), gives an element without a
/// version the version 1 (:20454), and answers every appState key it knows,
/// each one the scene lacks at its default (chunk:20793-20843).
function restore(data: Scene | null): { elements: Element[]; appState: AppState; files: Files } {
  const supplied = data?.appState ?? {};
  const appState: AppState = {};
  for (const [key, fallback] of Object.entries({ ...SERIALIZED_APP_STATE, ...VIEW_APP_STATE })) {
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

/// The library's `reconcileElements` (index.js:32859-32888), reduced to its
/// version rule (:32828-32837): a remote element replaces the local one unless
/// the local one is newer, or as new with the lower `versionNonce`, and the
/// local elements the remote does not name follow. It leaves out the editing
/// state that also keeps a local element, and the order by fractional index.
function reconcileElements(local: readonly Element[], remote: readonly Element[]): Element[] {
  const mine = new Map(local.map((element) => [element.id, element]));
  const kept = new Map<unknown, Element>();
  for (const element of remote) {
    if (kept.has(element.id)) continue;
    const own = mine.get(element.id);
    const ownWins =
      own !== undefined &&
      (Number(own.version) > Number(element.version) ||
        (own.version === element.version && Number(own.versionNonce) < Number(element.versionNonce)));
    kept.set(element.id, ownWins ? own : element);
  }
  for (const element of local) if (!kept.has(element.id)) kept.set(element.id, element);
  return [...kept.values()];
}

/// The module the canvas imports, for `vi.mock("@excalidraw/excalidraw")`.
export const excalidrawModule = {
  Excalidraw: () => null,
  restore,
  serializeAsJSON,
  reconcileElements,
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

/// Follow the React elements around a board, including an error boundary.
export function boardPropsFromRender(rendered: unknown): BoardProps {
  if (!rendered || typeof rendered !== "object") throw new Error("board render has no element");
  if ("excalidrawAPI" in rendered) return rendered as BoardProps;
  const props = (rendered as { props?: unknown }).props;
  if (!props || typeof props !== "object") throw new Error("board render has no props");
  if ("excalidrawAPI" in props) return props as BoardProps;
  return boardPropsFromRender((props as { children?: unknown }).children);
}

export type Board = {
  /// The elements on the board.
  readonly elements: unknown[];
  /// The appState keys the serializer keeps, as `getAppState()` shows them.
  readonly appState: AppState;
  /// View mode and zoom, as `getAppState()` shows them.
  readonly view: { viewModeEnabled: unknown; zoom: unknown };
  /// The files on the board.
  readonly files: Files;
  /// The props of the render App was built with, from the handover on.
  readonly mountedWith: BoardProps | null;
  /// Steps 1 and 2: the locale import, then the API handover.
  handOver(): Promise<void>;
  /// Steps 3 and 4: the awaited initial data replaces every element, then the
  /// first `onChange`. `between` runs after the first and before the second,
  /// where a task that lands between the init's apply and its first change
  /// runs.
  init(between?: () => void): Promise<void>;
  /// Steps 1 to 4.
  start(): Promise<void>;
  /// A user's stroke: the library adds the element and reports the change.
  stroke(element: unknown): void;
  /// A user's zoom or pick of a background, in the library's own render: the
  /// state shows it at once and the change is reported.
  zoomTo(value: number): void;
  pickBackground(color: string): void;
  /// Keep the renders that show an update's appState until `render` runs them.
  holdRenders(): void;
  /// Run the held renders: each shows its appState and reports the change.
  render(): Promise<void>;
  /// Step 8: the library marks every image of a file that failed to decode
  /// and reports the change.
  failImageDecode(fileId: string): void;
  /// Unmount the library's App and report its failure to a rendered boundary.
  fail(): void;
};

/// A board whose App is built, at the handover, with the props of the render
/// `latest` returns then.
export function excalidrawBoard(latest: () => unknown): Board {
  const latestProps = () => boardPropsFromRender(latest());
  let mountedWith: BoardProps | null = null;
  let elements: Element[] = [];
  let appState: AppState = { ...SERIALIZED_APP_STATE, ...VIEW_APP_STATE };
  let files: Files = {};
  let loading = true;
  let held: (() => void)[] | null = null;
  // The render an update schedules: it shows the update's appState and
  // reports the change, at a later task or when the test runs held renders.
  const scheduleRender = (next: AppState | undefined) => {
    const run = () => {
      if (next) appState = { ...appState, ...next };
      if (!loading) latestProps().onChange();
    };
    if (held) held.push(run);
    else setTimeout(run, 0);
  };
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
      scheduleRender(scene.appState);
    },
  };
  return {
    get elements() {
      return elements;
    },
    get appState() {
      return Object.fromEntries(Object.keys(SERIALIZED_APP_STATE).map((key) => [key, appState[key]]));
    },
    get view() {
      return { viewModeEnabled: appState.viewModeEnabled, zoom: appState.zoom };
    },
    get files() {
      return files;
    },
    get mountedWith() {
      return mountedWith;
    },
    async handOver() {
      await Promise.resolve();
      mountedWith = latestProps();
      mountedWith.excalidrawAPI(api);
    },
    async init(between) {
      const scene = restore((await mountedWith!.initialData) ?? null);
      elements = scene.elements;
      appState = { ...appState, ...scene.appState, viewModeEnabled: mountedWith!.viewModeEnabled ?? false };
      files = { ...scene.files };
      loading = false;
      between?.();
      latestProps().onChange();
    },
    async start() {
      await this.handOver();
      await this.init();
    },
    stroke(element) {
      elements = [...elements, element as Element];
      latestProps().onChange();
    },
    zoomTo(value) {
      appState = { ...appState, zoom: { value } };
      latestProps().onChange();
    },
    pickBackground(color) {
      appState = { ...appState, viewBackgroundColor: color };
      latestProps().onChange();
    },
    holdRenders() {
      held ??= [];
    },
    async render() {
      const runs = held ?? [];
      held = null;
      for (const run of runs) run();
      await Promise.resolve();
    },
    failImageDecode(fileId) {
      elements = elements.map((element) =>
        element.type === "image" && element.fileId === fileId && element.status !== "error"
          ? {
              ...element,
              status: "error",
              updated: Date.now(),
              version: Number(element.version) + 1,
              versionNonce: Number(element.versionNonce ?? 0) + 1,
            }
          : element,
      );
      latestProps().onChange();
    },
    fail() {
      elements = [];
      files = {};
      const rendered = latest() as { type?: unknown; props?: unknown };
      const boundary = rendered?.type as {
        new (props: unknown): { state: Record<string, unknown>; componentDidCatch?: (error: Error) => void };
        getDerivedStateFromError?: (error: Error) => Record<string, unknown>;
      } | undefined;
      if (!boundary?.getDerivedStateFromError) return;
      const error = new Error("drawing library failed");
      const instance = new boundary(rendered.props);
      instance.state = { ...instance.state, ...boundary.getDerivedStateFromError(error) };
      instance.componentDidCatch?.(error);
    },
  };
}
