// A stand-in for the Excalidraw board, for tests that mount ExcalidrawCanvas
// with React and the drawing library mocked out. It keeps the library's order
// of events, which the canvas's seeding depends on.
//
// The order is read from @excalidraw/excalidraw 0.18.1's source
// (dist/dev/index.js) and was not run in a browser:
//   1. <InitializeApp> awaits a locale import before it renders <App> (:911-921).
//   2. App's constructor starts with `isLoading: true` and hands the imperative
//      API over (:29454), before componentDidMount.
//   3. initializeScene awaits `initialData` (:25241-25245) and replaces every
//      element with it (:25130-25131), wiping any `updateScene` made since
//      step 2, then clears `isLoading` (:25272).
//   4. `onChange` fires after every update once `isLoading` is false
//      (:30536-30538): the first is the init's own, and none comes before it.
//   5. After the init, `updateScene` replaces the elements at once, and its
//      `onChange` follows the render it schedules (:25957-25974).
//
// EXCALIDRAW_VERSION is the version that order was read from. A test fails when
// the installed package is another, so an upgrade reads the order again.

export const EXCALIDRAW_VERSION = "0.18.1";

/// The props the canvas renders the board with, as the mocked createElement
/// hands them to the mocked root.
export type BoardProps = {
  initialData?: { elements?: unknown[] } | null;
  excalidrawAPI: (api: unknown) => void;
  onChange: () => void;
  viewModeEnabled?: boolean;
};

export type Board = {
  /// The elements on the board.
  readonly elements: unknown[];
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

export function excalidrawBoard(props: BoardProps): Board {
  let elements: unknown[] = [];
  let loading = true;
  const api = {
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({ isLoading: loading }),
    getFiles: () => ({}),
    addFiles: () => {},
    updateScene(scene: { elements?: unknown[] }) {
      if (scene.elements) elements = scene.elements;
      if (!loading) queueMicrotask(props.onChange);
    },
  };
  return {
    get elements() {
      return elements;
    },
    async handOver() {
      await Promise.resolve();
      props.excalidrawAPI(api);
    },
    async init() {
      const data = await props.initialData;
      elements = data?.elements ?? [];
      loading = false;
      props.onChange();
    },
    async start() {
      await this.handOver();
      await this.init();
    },
    stroke(element) {
      elements = [...elements, element];
      props.onChange();
    },
  };
}
